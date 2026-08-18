import { RPC_ERROR_CODES, type RpcErrorCode } from '@companion/protocol';

export interface RpcHandlerDeps {
  /** The daemon's own version string (from package.json), reported by `ping`. */
  version: string;
  /** Epoch ms when this daemon process started — `ping` reports uptime relative to this. */
  startedAt: number;
  /** Injectable clock, purely for tests. Defaults to Date.now. */
  now?: () => number;
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

/**
 * The daemon's RPC method registry: method name -> handler. `ping` is the only method implemented
 * in this task — a trivial proving ground for the device-scoped RPC channel itself (see the
 * reliable-transport plan's Task 6). Project 3 (session adoption) is expected to add the real
 * "what could I adopt" methods here later; nothing about this registry's shape needs to change to
 * accommodate that — a new entry is a new key.
 */
const REGISTRY: Record<string, RpcHandler> = {
  ping: (_params, deps): PingResult => ({
    version: deps.version,
    uptimeMs: (deps.now ?? Date.now)() - deps.startedAt,
  }),
};

/**
 * Looks up `method` in `registry` and runs it, translating every outcome — success, an unknown
 * method, or a thrown error — into the `{result} | {error}` shape RelayClient sends back over the
 * wire (see relay-client.ts's `handleRpcRequest`). Never throws itself: an unrecognized method
 * (e.g. an old cached service worker calling a method a newer daemon renamed or removed — see the
 * Global Constraints in the Task 6 brief) and a handler that throws are both ordinary, expected
 * outcomes here, not process-level failures.
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
    return { result };
  } catch {
    return { error: RPC_ERROR_CODES.HANDLER_ERROR };
  }
}
