import { WebSocket } from 'ws';
import { RelayMessage, type Command, type SessionEvent } from '@companion/protocol';

export interface RelayClientOptions {
  url: string;
  token: string;
  onCommand: (command: Command) => void;
  onOpen?: () => void;
  onLog?: (message: string) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Persistent outbound WebSocket connection from the daemon to the relay.
 * Forwards SessionEvents out, dispatches Commands in, and reconnects with
 * exponential backoff on any disconnect until close() is called.
 */
export class RelayClient {
  private readonly url: string;
  private readonly token: string;
  private readonly onCommand: (command: Command) => void;
  private readonly onOpenCallback: () => void;
  private readonly onLog: (message: string) => void;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private ws: WebSocket | undefined;
  private backoffMs: number;
  private closed = true;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(options: RelayClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.onCommand = options.onCommand;
    this.onOpenCallback = options.onOpen ?? (() => {});
    this.onLog = options.onLog ?? (() => {});
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.backoffMs = this.initialBackoffMs;
  }

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  sendEvent(sessionId: string, event: SessionEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.onLog(`Dropping event ${event.type} for session ${sessionId}: not connected to relay`);
      return;
    }
    const message: RelayMessage = { kind: 'event', sessionId, seq: 0, event };
    this.ws.send(JSON.stringify(message));
  }

  private openSocket(): void {
    const separator = this.url.includes('?') ? '&' : '?';
    const ws = new WebSocket(`${this.url}${separator}token=${encodeURIComponent(this.token)}`);
    this.ws = ws;

    // Attached before any other listener: an 'error' event with no listener is an
    // uncaught exception that terminates the process.
    ws.on('error', (err) => {
      this.onLog(`Relay connection error: ${err.message}`);
    });

    ws.on('open', () => {
      this.backoffMs = this.initialBackoffMs;
      this.onLog('Connected to relay');
      this.onOpenCallback();
    });

    ws.on('message', (raw) => {
      let parsed: RelayMessage;
      try {
        parsed = RelayMessage.parse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (parsed.kind === 'command') {
        this.onCommand(parsed.command);
      }
    });

    ws.on('close', () => {
      if (this.closed) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }
}
