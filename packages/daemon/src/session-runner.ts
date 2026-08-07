import { AsyncQueue } from './async-queue.js';
import type {
  AgentMessage,
  AgentQuery,
  PermissionRequest,
  PermissionResponse,
  QueryFn,
} from './agent-sdk-port.js';
import type { SessionEvent, SessionStatus } from '@companion/protocol';

export interface SessionRunnerOptions {
  id: string;
  projectPath: string;
  queryFn: QueryFn;
  onEvent: (event: SessionEvent) => void;
}

export class SessionRunner {
  readonly id: string;
  private readonly projectPath: string;
  private readonly queryFn: QueryFn;
  private readonly onEvent: (event: SessionEvent) => void;
  private inputQueue = new AsyncQueue<{ type: 'user'; text: string }>();
  private agentQuery: AgentQuery | undefined;
  private _status: SessionStatus = 'running';
  private pendingPermissions = new Map<string, (response: PermissionResponse) => void>();

  constructor(options: SessionRunnerOptions) {
    this.id = options.id;
    this.projectPath = options.projectPath;
    this.queryFn = options.queryFn;
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
    // Guard against double invocation
    if (this._status === 'stopped') {
      return;
    }
    if (!this.agentQuery) throw new Error(`Session ${this.id} has not started`);

    // Resolve any pending permissions before closing
    const pendingRequestIds = Array.from(this.pendingPermissions.keys());
    for (const requestId of pendingRequestIds) {
      const resolve = this.pendingPermissions.get(requestId);
      if (resolve) {
        this.pendingPermissions.delete(requestId);
        resolve({ approved: false, reason: 'session stopped' });
      }
    }

    this.inputQueue.close();
    this.agentQuery.close();
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
      // mark session as stopped and emit a stopped event
      if (this._status !== 'stopped') {
        this._status = 'stopped';
        this.emit({ type: 'stopped', sessionId: this.id, at: Date.now() });
      }
    } catch (err) {
      this.emit({
        type: 'error',
        sessionId: this.id,
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
      this._status = 'stopped';
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
        this.emit({ type: 'turn_complete', sessionId: this.id, at: Date.now() });
        break;
      default:
        break;
    }
  }

  private emit(event: SessionEvent): void {
    this.onEvent(event);
  }
}
