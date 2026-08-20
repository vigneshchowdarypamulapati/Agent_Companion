import { randomUUID } from 'node:crypto';
import { SessionRunner } from './session-runner.js';
import type { QueryFn, GetSessionMessagesFn } from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';
import { recordProjectUsed } from './project-store.js';

/** Default cap on non-stopped sessions this daemon will run at once, if `main.ts` doesn't
 * override it from `COMPANION_MAX_CONCURRENT_SESSIONS`. Chosen to comfortably cover normal
 * multi-project use while still bounding worst-case resource/API cost from a client that starts
 * many sessions without stopping any — same reasoning as this project's other bounded caps
 * (RPC_IN_FLIGHT_CAP_PER_DEVICE in the relay's hub.ts). */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

export interface SessionManagerOptions {
  queryFn: QueryFn;
  getSessionMessagesFn: GetSessionMessagesFn;
  onEvent: (event: SessionEvent) => void;
  /** Where the known-projects list is persisted — see project-store.ts. Required, not defaulted
   * here: the daemon's actual path (~/.companion/daemon-projects.json by default, overridable via
   * COMPANION_PROJECTS_FILE_PATH) is main.ts's concern, not this class's. */
  projectStoreFilePath: string;
  maxConcurrentSessions?: number;
}

export class SessionManager {
  private readonly queryFn: QueryFn;
  private readonly getSessionMessagesFn: GetSessionMessagesFn;
  private readonly onEvent: (event: SessionEvent) => void;
  private readonly projectStoreFilePath: string;
  private readonly maxConcurrentSessions: number;
  private sessions = new Map<string, SessionRunner>();

  constructor(options: SessionManagerOptions) {
    this.queryFn = options.queryFn;
    this.getSessionMessagesFn = options.getSessionMessagesFn;
    this.onEvent = options.onEvent;
    this.projectStoreFilePath = options.projectStoreFilePath;
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
  }

  /** Count of sessions currently occupying a concurrency slot. A stopped session is removed from
   * `this.sessions` entirely (see the `onEvent` wrapper below), so this is simply the map's
   * size — no separate status filter needed. */
  private activeCount(): number {
    return this.sessions.size;
  }

  startSession(projectPath: string, prompt: string): SessionRunner {
    if (this.activeCount() >= this.maxConcurrentSessions) {
      // Carries `isCapExceeded: true` so a later RPC layer can distinguish "at capacity" (should
      // become a CONCURRENT_SESSION_LIMIT RPC error) from "this specific session failed to
      // start" (the plain re-throw in the catch block below) rather than conflating them.
      throw Object.assign(
        new Error(
          `Cannot start a new session: already at the limit of ${this.maxConcurrentSessions} concurrent sessions.`
        ),
        { isCapExceeded: true }
      );
    }
    const id = randomUUID();
    const runner = new SessionRunner({
      id,
      projectPath,
      queryFn: this.queryFn,
      getSessionMessagesFn: this.getSessionMessagesFn,
      onEvent: (event) => {
        // A stopped session is removed here, not merely excluded from some separate "active" set.
        // Before this fix, SessionManager never removed a finished session from `this.sessions` at
        // all — only a single-session "active pointer" was cleared, so the SessionRunner (and
        // everything it holds) stayed reachable, and therefore in memory, for the rest of the
        // daemon process's lifetime. That was rarely hit when starting a session was a rare,
        // manual, one-at-a-time act; this feature makes it frequent and phone-driven, turning the
        // same latent leak into a real one — and hitting hardest the users who use it most. Nothing
        // else needs a stopped session's runner reachable afterward: stopSession looks it up
        // *before* stopping (not after), every other daemon-side operation already refuses to act
        // on a stopped session, and session history is served from the relay's durable store, not
        // from this in-memory map.
        if (event.type === 'stopped') {
          this.sessions.delete(id);
        }
        this.onEvent(event);
      },
    });
    this.sessions.set(id, runner);
    try {
      runner.start(prompt);
    } catch (err) {
      this.sessions.delete(id);
      throw err;
    }
    // Fire-and-forget: recording project history must never block or fail session startup — a
    // disk write hiccup here is not a reason to refuse to start a session the caller already
    // committed to.
    void recordProjectUsed(projectPath, { filePath: this.projectStoreFilePath }).catch(() => {});
    return runner;
  }

  adoptSession(projectPath: string, originalSessionId: string): SessionRunner {
    if (this.activeCount() >= this.maxConcurrentSessions) {
      throw Object.assign(
        new Error(
          `Cannot adopt a session: already at the limit of ${this.maxConcurrentSessions} concurrent sessions.`
        ),
        { isCapExceeded: true }
      );
    }
    const id = randomUUID();
    const runner = new SessionRunner({
      id,
      projectPath,
      queryFn: this.queryFn,
      getSessionMessagesFn: this.getSessionMessagesFn,
      onEvent: (event) => {
        if (event.type === 'stopped') {
          this.sessions.delete(id);
        }
        this.onEvent(event);
      },
    });
    this.sessions.set(id, runner);
    try {
      runner.adopt(originalSessionId);
    } catch (err) {
      this.sessions.delete(id);
      throw err;
    }
    void recordProjectUsed(projectPath, { filePath: this.projectStoreFilePath }).catch(() => {});
    return runner;
  }

  getSession(id: string): SessionRunner {
    const runner = this.sessions.get(id);
    if (!runner) throw new Error(`No session with id ${id}`);
    return runner;
  }

  async stopSession(id: string): Promise<void> {
    const runner = this.getSession(id);
    await runner.stop();
  }
}
