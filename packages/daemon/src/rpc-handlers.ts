import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { RPC_ERROR_CODES, type RpcErrorCode } from '@companion/protocol';
import type { SessionManager } from './session-manager.js';
import { listKnownProjects } from './project-store.js';

export interface RpcHandlerDeps {
  /** The daemon's own version string (from package.json), reported by `ping`. */
  version: string;
  /** Epoch ms when this daemon process started — `ping` reports uptime relative to this. */
  startedAt: number;
  /** Injectable clock, purely for tests. Defaults to Date.now. */
  now?: () => number;
  /** Needed by start_session to actually start one, and by list_projects/start_session's
   * cap-exceeded translation. */
  manager: SessionManager;
  /** Same path SessionManager was constructed with — list_projects reads it directly rather than
   * asking SessionManager for it, since the known-projects list is project-store's concern, not
   * SessionManager's. */
  projectStoreFilePath: string;
  /** COMPANION_PROJECTS_ROOT, if set. One directory; its immediate subdirectories are offered as
   * startable even with no session history. */
  projectsRoot: string | undefined;
}

export type RpcHandler = (params: unknown, deps: RpcHandlerDeps) => unknown | Promise<unknown>;

export interface RpcOutcome {
  result?: unknown;
  error?: RpcErrorCode;
}

export interface PingResult {
  version: string;
  uptimeMs: number;
}

export interface ProjectListEntry {
  path: string;
  displayName: string;
  source: 'history' | 'configured';
  lastUsedAt: number | undefined;
}

async function pathExistsAsDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * The merged, deduplicated, existence-filtered set of projects this daemon will accept a
 * start_session call for. Shared by both list_projects (reports it) and start_session (re-derives
 * it to validate against — never trusts a phone's earlier list call, since a path can vanish
 * between listing and starting).
 */
async function resolveKnownProjects(deps: RpcHandlerDeps): Promise<ProjectListEntry[]> {
  const known = await listKnownProjects({ filePath: deps.projectStoreFilePath });
  const historyPaths = new Set(known.map((p) => p.path));
  const entries: ProjectListEntry[] = [];

  for (const project of known) {
    if (await pathExistsAsDirectory(project.path)) {
      entries.push({
        path: project.path,
        displayName: basename(project.path),
        source: 'history',
        lastUsedAt: project.lastUsedAt,
      });
    }
  }

  if (deps.projectsRoot) {
    let rootEntries: string[] = [];
    try {
      const dirents = await readdir(deps.projectsRoot, { withFileTypes: true });
      rootEntries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      // Missing/unreadable COMPANION_PROJECTS_ROOT is a configuration issue for the operator to
      // notice locally (the daemon's own startup log is the right place for that — not here);
      // list_projects degrades to history-only rather than failing the whole RPC.
      rootEntries = [];
    }
    for (const name of rootEntries) {
      const fullPath = join(deps.projectsRoot, name);
      if (historyPaths.has(fullPath)) continue; // already included above as 'history'
      entries.push({ path: fullPath, displayName: name, source: 'configured', lastUsedAt: undefined });
    }
  }

  entries.sort((a, b) => {
    if (a.source === 'history' && b.source === 'history') return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
    if (a.source !== b.source) return a.source === 'history' ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
  return entries;
}

interface StartSessionParams {
  projectPath: string;
  prompt: string;
}

function isStartSessionParams(params: unknown): params is StartSessionParams {
  return (
    typeof params === 'object' &&
    params !== null &&
    typeof (params as StartSessionParams).projectPath === 'string' &&
    typeof (params as StartSessionParams).prompt === 'string'
  );
}

/**
 * The daemon's RPC method registry: method name -> handler.
 *
 * `list_projects` and `start_session` are the two methods a phone actually calls to start a
 * session on its paired daemon. Both failure paths in `start_session` throw with an `rpcCode`
 * marker (see `dispatchRpc` below) rather than returning an error shape directly, so every
 * failure — bad params, an unknown/vanished path, the concurrency cap, or a genuine runner-start
 * crash — flows through the same single translation site.
 */
const REGISTRY: Record<string, RpcHandler> = {
  ping: (_params, deps): PingResult => ({
    version: deps.version,
    uptimeMs: (deps.now ?? Date.now)() - deps.startedAt,
  }),
  list_projects: async (_params, deps) => resolveKnownProjects(deps),
  start_session: async (params, deps): Promise<{ id: string; status: string }> => {
    if (!isStartSessionParams(params)) {
      throw Object.assign(new Error('invalid start_session params'), {
        rpcCode: RPC_ERROR_CODES.INVALID_PROJECT_PATH,
      });
    }
    const known = await resolveKnownProjects(deps);
    if (!known.some((p) => p.path === params.projectPath)) {
      throw Object.assign(new Error('invalid project path'), { rpcCode: RPC_ERROR_CODES.INVALID_PROJECT_PATH });
    }
    try {
      const runner = deps.manager.startSession(params.projectPath, params.prompt);
      return { id: runner.id, status: runner.status };
    } catch (err) {
      if (err instanceof Error && (err as Error & { isCapExceeded?: boolean }).isCapExceeded) {
        throw Object.assign(new Error(err.message), { rpcCode: RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT });
      }
      // A genuine runner-start failure (bad cwd, SDK error, etc.) — NOT a capacity issue. Re-throw
      // without an rpcCode marker so dispatchRpc's own catch falls through to its generic
      // HANDLER_ERROR translation, rather than this handler mislabeling an unrelated crash as
      // "you're at the concurrent session limit" and pointing the user at the wrong remedy.
      throw err;
    }
  },
};

/**
 * Looks up `method` in `registry` and runs it, translating every outcome — success, an unknown
 * method, or a thrown error — into the `{result} | {error}` shape RelayClient sends back over the
 * wire (see relay-client.ts's `handleRpcRequest`). Never throws itself: an unrecognized method
 * (e.g. an old cached service worker calling a method a newer daemon renamed or removed — see the
 * Global Constraints in the Task 6 brief) and a handler that throws are both ordinary, expected
 * outcomes here, not process-level failures.
 *
 * A thrown error carrying an `rpcCode` (the convention every handler above uses for its own
 * expected failure modes — bad params, an invalid project path, the concurrency cap) is reported
 * as that specific code; any other throw — a genuine bug, an unexpected crash — falls back to the
 * generic `HANDLER_ERROR`. This keeps `dispatchRpc` the single place that decides what an
 * outcome's wire shape is: a handler never constructs `{error: ...}` directly, it only throws.
 *
 * `registry` defaults to the real REGISTRY above and is only ever overridden in this file's own
 * tests, to exercise the "a registered handler throws" path without needing a real handler that
 * can be made to fail on demand.
 */
export async function dispatchRpc(
  method: string,
  params: unknown,
  deps: RpcHandlerDeps,
  registry: Record<string, RpcHandler> = REGISTRY
): Promise<RpcOutcome> {
  const handler = registry[method];
  if (!handler) return { error: RPC_ERROR_CODES.UNKNOWN_METHOD };
  try {
    const result = await handler(params, deps);
    // Normalized to `null` rather than left `undefined`: RpcResponseMessage's wire invariant
    // (@companion/protocol's relay.ts) requires exactly one of `result`/`error` to be *present*,
    // and JSON.stringify silently drops an undefined-valued key rather than serializing it — a
    // handler that legitimately has nothing to return would otherwise produce a frame with
    // neither field, which the relay would reject as malformed instead of routing it.
    return { result: result === undefined ? null : result };
  } catch (err) {
    const rpcCode = (err as { rpcCode?: RpcErrorCode })?.rpcCode;
    return { error: rpcCode ?? RPC_ERROR_CODES.HANDLER_ERROR };
  }
}
