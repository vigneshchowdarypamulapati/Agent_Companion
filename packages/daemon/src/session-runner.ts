import { AsyncQueue } from './async-queue.js';
import type {
  AgentMessage,
  AgentQuery,
  GetSessionMessagesFn,
  PermissionRequest,
  PermissionResponse,
  QueryFn,
} from './agent-sdk-port.js';
import type { SessionEvent, SessionStatus } from '@companion/protocol';

/** Most recent N prior messages carried into an adopted session's `adopted_history` event.
 * Bounded for the same reason every other cap in this codebase is bounded — see
 * docs/superpowers/specs/2026-08-20-session-adoption-design.md. */
const HISTORY_MESSAGE_CAP = 50;

/** Byte budget for a single adopted_history event's serialized `messages` array — well clear of
 * the relay's 1 MiB WebSocket frame limit (packages/relay/src/server.ts's maxPayload) even
 * accounting for JSON envelope overhead. HISTORY_MESSAGE_CAP bounds message *count* only;
 * message *text* comes from an arbitrary pre-existing transcript this daemon didn't generate and
 * can be arbitrarily large (e.g. a pasted log or diff) — this budget is what actually prevents
 * an oversized frame from wedging the daemon's relay connection (see the final-review finding
 * this fixes: an oversized frame gets the socket closed, and RelayClient's reconnect replays
 * unacked buffered entries first, hitting the same frame and looping). */
const MAX_HISTORY_BYTES = 256 * 1024;
/** Clamps a single oversized historical message so it alone can never blow MAX_HISTORY_BYTES —
 * without this, one huge pasted turn could exceed the byte budget on its own and leave zero
 * messages in the final result. */
const MAX_MESSAGE_CHARS = 20_000;

function clampMessageText(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return text.slice(0, MAX_MESSAGE_CHARS) + '… [truncated]';
}

export interface SessionRunnerOptions {
  id: string;
  projectPath: string;
  queryFn: QueryFn;
  getSessionMessagesFn: GetSessionMessagesFn;
  onEvent: (event: SessionEvent) => void;
}

export class SessionRunner {
  readonly id: string;
  private readonly projectPath: string;
  private readonly queryFn: QueryFn;
  private readonly getSessionMessagesFn: GetSessionMessagesFn;
  private readonly onEvent: (event: SessionEvent) => void;
  private inputQueue = new AsyncQueue<{ type: 'user'; text: string }>();
  private agentQuery: AgentQuery | undefined;
  private _status: SessionStatus = 'running';
  private pendingPermissions = new Map<string, (response: PermissionResponse) => void>();

  constructor(options: SessionRunnerOptions) {
    this.id = options.id;
    this.projectPath = options.projectPath;
    this.queryFn = options.queryFn;
    this.getSessionMessagesFn = options.getSessionMessagesFn;
    this.onEvent = options.onEvent;
  }

  get status(): SessionStatus {
    return this._status;
  }

  start(initialPrompt: string): void {
    this.agentQuery = this.queryFn({
      prompt: this.inputQueue,
      options: {
        cwd: this.projectPath,
        canUseTool: (request) => this.handlePermissionRequest(request),
      },
    });
    this.inputQueue.push({ type: 'user', text: initialPrompt });
    this.emit({
      type: 'session_started',
      sessionId: this.id,
      projectPath: this.projectPath,
      at: Date.now(),
    });
    void this.drainMessages();
  }

  /**
   * Starts a session by forking an existing, externally-started Claude Code session rather than
   * beginning a brand-new one. Structurally mirrors `start()` — same query construction, same
   * session_started emission, same drainMessages() loop — with two differences: no initial
   * prompt is pushed (the user lands in the session free to type whenever), and the original
   * session's prior conversation is fetched once and emitted as a single adopted_history event
   * right after session_started.
   */
  adopt(originalSessionId: string): void {
    this.agentQuery = this.queryFn({
      prompt: this.inputQueue,
      options: {
        cwd: this.projectPath,
        canUseTool: (request) => this.handlePermissionRequest(request),
        sessionId: this.id,
        resumeSessionId: originalSessionId,
      },
    });
    this.emit({
      type: 'session_started',
      sessionId: this.id,
      projectPath: this.projectPath,
      at: Date.now(),
    });
    void this.emitAdoptedHistory(originalSessionId).catch(() => {
      // History delivery is best-effort: a failed fetch (e.g. the original transcript file was
      // deleted between adopt_session's re-validation and this call) must not crash or block
      // the now-live adopted session. The session proceeds with no prior-conversation context
      // shown, which is a strictly worse UX than showing it, never a broken one.
    });
    void this.drainMessages();
  }

  private async emitAdoptedHistory(originalSessionId: string): Promise<void> {
    const allMessages = await this.getSessionMessagesFn(originalSessionId, { dir: this.projectPath });
    const truncatedByCount = allMessages.length > HISTORY_MESSAGE_CAP;
    let truncatedByMessage = false;
    const clamped = allMessages.slice(-HISTORY_MESSAGE_CAP).map((m) => {
      if (m.text.length > MAX_MESSAGE_CHARS) truncatedByMessage = true;
      return { role: m.role, text: clampMessageText(m.text) };
    });

    // Walk from the most recent message backward, keeping messages while under the byte budget.
    // This is what actually prevents an oversized WebSocket frame — the count cap alone doesn't.
    let bytes = 0;
    let cutoff = clamped.length;
    for (let i = clamped.length - 1; i >= 0; i--) {
      bytes += Buffer.byteLength(JSON.stringify(clamped[i]), 'utf8');
      if (bytes > MAX_HISTORY_BYTES) {
        cutoff = i + 1;
        break;
      }
      cutoff = i;
    }
    const messages = clamped.slice(cutoff);
    const truncatedBySize = cutoff > 0;

    if (messages.length === 0 && !truncatedByCount && !truncatedBySize && !truncatedByMessage) {
      // Fix 5 (Minor, bundled here since it's the same method): nothing to show — e.g. the
      // original session's history was entirely tool-use turns with no extractable text.
      // Skip emitting an event with an empty "Prior conversation" header and nothing under it.
      return;
    }

    this.emit({
      type: 'adopted_history',
      sessionId: this.id,
      originalSessionId,
      messages,
      truncated: truncatedByCount || truncatedBySize || truncatedByMessage,
      at: Date.now(),
    });
  }

  injectPrompt(text: string): void {
    if (this._status === 'stopped') {
      throw new Error(`Cannot inject a prompt into stopped session ${this.id}`);
    }
    if (this._status === 'waiting_permission') {
      throw new Error(
        `Cannot inject a prompt into session ${this.id} while a permission request is pending`
      );
    }
    this._status = 'running';
    this.inputQueue.push({ type: 'user', text });
  }

  respondToPermission(requestId: string, response: PermissionResponse): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) {
      throw new Error(`No pending permission request ${requestId} on session ${this.id}`);
    }
    this.pendingPermissions.delete(requestId);
    resolve(response);
    this.emit({
      type: 'permission_resolved',
      sessionId: this.id,
      requestId,
      approved: response.approved,
      at: Date.now(),
    });
    // Only revert status to running if session is not already stopped
    if (this.pendingPermissions.size === 0 && this._status !== 'stopped') {
      this._status = 'running';
    }
  }

  async pause(): Promise<void> {
    if (!this.agentQuery) throw new Error(`Session ${this.id} has not started`);
    if (this._status === 'stopped') {
      throw new Error(`Cannot pause stopped session ${this.id}`);
    }
    if (this._status === 'waiting_permission') {
      throw new Error(`Cannot pause session ${this.id} while waiting for permission`);
    }
    await this.agentQuery.interrupt();
    this._status = 'paused';
  }

  resume(): void {
    if (this._status !== 'paused') {
      throw new Error(`Cannot resume session ${this.id} from status ${this._status}`);
    }
    this._status = 'running';
  }

  async stop(): Promise<void> {
    if (!this.agentQuery) throw new Error(`Session ${this.id} has not started`);
    this.finalize('stopped');
  }

  /**
   * Consolidated termination path. Called from stop() (explicit stop), the
   * graceful stream-completion path, and the crash path in drainMessages().
   * Idempotent: only the first call performs cleanup.
   */
  private finalize(reason: 'stopped' | 'completed' | 'crashed'): void {
    if (this._status === 'stopped') {
      return;
    }

    // Resolve any pending permissions before closing so the real SDK
    // adapter's canUseTool await never hangs forever.
    for (const [requestId, resolve] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId);
      resolve({ approved: false, reason: `session ${reason}` });
    }

    try {
      this.inputQueue.close();
    } catch {
      // already closed
    }
    this.agentQuery?.close();
    this._status = 'stopped';
    this.emit({ type: 'stopped', sessionId: this.id, at: Date.now() });
  }

  private handlePermissionRequest(request: PermissionRequest): Promise<PermissionResponse> {
    this._status = 'waiting_permission';
    this.emit({
      type: 'permission_request',
      sessionId: this.id,
      requestId: request.requestId,
      toolName: request.toolName,
      input: request.input,
      at: Date.now(),
    });
    return new Promise((resolve) => {
      this.pendingPermissions.set(request.requestId, resolve);
    });
  }

  private async drainMessages(): Promise<void> {
    if (!this.agentQuery) return;
    try {
      for await (const message of this.agentQuery) {
        this.handleMessage(message);
      }
      // Handle graceful stream completion: if stream ends without explicit stop(),
      // run the same cleanup stop() would perform.
      this.finalize('completed');
    } catch (err) {
      this.emit({
        type: 'error',
        sessionId: this.id,
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
      this.finalize('crashed');
    }
  }

  private handleMessage(message: AgentMessage): void {
    switch (message.type) {
      case 'assistant_text':
        this.emit({
          type: 'assistant_text',
          sessionId: this.id,
          text: String(message.text ?? ''),
          at: Date.now(),
        });
        break;
      case 'tool_use':
        this.emit({
          type: 'tool_use',
          sessionId: this.id,
          toolName: String(message.toolName ?? ''),
          input: message.input,
          at: Date.now(),
        });
        break;
      case 'tool_result':
        this.emit({
          type: 'tool_result',
          sessionId: this.id,
          toolName: String(message.toolName ?? ''),
          isError: Boolean(message.isError),
          at: Date.now(),
        });
        break;
      case 'turn_complete':
        // pause() sets _status to 'paused' as soon as interrupt() resolves, and the SDK
        // guarantees the interrupted turn's result message arrives strictly after that —
        // so a turn_complete seen while paused is the deliberate interrupt's echo, not a
        // real "Claude is idle, waiting for a reply" moment. Suppressing it here (rather
        // than in the relay) is what avoids a push notification firing the instant a user
        // hits Pause.
        if (this._status !== 'paused') {
          this.emit({ type: 'turn_complete', sessionId: this.id, at: Date.now() });
        }
        break;
      default:
        break;
    }
  }

  private emit(event: SessionEvent): void {
    this.onEvent(event);
  }
}
