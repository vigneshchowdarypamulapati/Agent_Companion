import { randomUUID } from 'node:crypto';
import { SessionRunner } from './session-runner.js';
import type { QueryFn } from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';

export interface SessionManagerOptions {
  queryFn: QueryFn;
  onEvent: (event: SessionEvent) => void;
}

export class SessionManager {
  private readonly queryFn: QueryFn;
  private readonly onEvent: (event: SessionEvent) => void;
  private sessions = new Map<string, SessionRunner>();
  private activeSessionId: string | undefined;

  constructor(options: SessionManagerOptions) {
    this.queryFn = options.queryFn;
    this.onEvent = options.onEvent;
  }

  startSession(projectPath: string, prompt: string): SessionRunner {
    if (this.activeSessionId) {
      throw new Error(
        `Cannot start a new session while session ${this.activeSessionId} is active. Stop it first.`
      );
    }
    const id = randomUUID();
    const runner = new SessionRunner({
      id,
      projectPath,
      queryFn: this.queryFn,
      onEvent: this.onEvent,
    });
    this.sessions.set(id, runner);
    this.activeSessionId = id;
    runner.start(prompt);
    return runner;
  }

  getSession(id: string): SessionRunner {
    const runner = this.sessions.get(id);
    if (!runner) throw new Error(`No session with id ${id}`);
    return runner;
  }

  getActiveSession(): SessionRunner | undefined {
    return this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
  }

  async stopSession(id: string): Promise<void> {
    const runner = this.getSession(id);
    await runner.stop();
    if (this.activeSessionId === id) {
      this.activeSessionId = undefined;
    }
  }
}
