import { RelayMessage, type Command, type SessionEvent } from '@companion/protocol';

export interface RelayConnectionOptions {
  url: string;
  token: string;
  onEvent: (message: { sessionId: string; seq: number; event: SessionEvent }) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /**
   * Fired when the relay closes the connection with code 4401 (invalid/missing token) or
   * 4403 (this device was unpaired) — signals that reconnecting with the same token would
   * just repeat the rejection. When this fires, the connection stops retrying.
   */
  onUnauthorized?: () => void;
  onLog?: (message: string) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * How long a connection must stay open before it counts as stable and the
   * reconnect backoff is reset. Defaults to 3000ms.
   */
  openConfirmMs?: number;
}

/**
 * Persistent outbound WebSocket connection from the browser to the relay.
 * Mirrors packages/daemon/src/relay-client.ts's reconnect-backoff shape and
 * untrusted-input discipline, but sends Commands and receives SessionEvents
 * (the daemon's client does the opposite), and uses the standard
 * addEventListener-style WebSocket API rather than the `ws` package's.
 */
export class RelayConnection {
  private readonly url: string;
  private readonly token: string;
  private readonly onEvent: (message: { sessionId: string; seq: number; event: SessionEvent }) => void;
  private readonly onOpenCallback: () => void;
  private readonly onCloseCallback: () => void;
  private readonly onUnauthorizedCallback: () => void;
  private readonly onLog: (message: string) => void;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly openConfirmMs: number;
  private ws: WebSocket | undefined;
  private backoffMs: number;
  private closed = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private openConfirmTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RelayConnectionOptions) {
    this.url = options.url;
    this.token = options.token;
    this.onEvent = options.onEvent;
    this.onOpenCallback = options.onOpen ?? (() => {});
    this.onCloseCallback = options.onClose ?? (() => {});
    this.onUnauthorizedCallback = options.onUnauthorized ?? (() => {});
    this.onLog = options.onLog ?? (() => {});
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.openConfirmMs = options.openConfirmMs ?? 3000;
    this.backoffMs = this.initialBackoffMs;
  }

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.openConfirmTimer) clearTimeout(this.openConfirmTimer);
    this.ws?.close();
  }

  sendCommand(sessionId: string, command: Command): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.onLog(`Dropping command ${command.type} for session ${sessionId}: not connected to relay`);
      return;
    }
    const message: RelayMessage = { kind: 'command', sessionId, command };
    this.ws.send(JSON.stringify(message));
  }

  private openSocket(): void {
    const base = `${this.url.replace(/\/$/, '')}/ws`;
    const separator = base.includes('?') ? '&' : '?';
    const target = `${base}${separator}token=${encodeURIComponent(this.token)}`;

    // A malformed relay URL makes the WebSocket constructor throw synchronously.
    // Log a generic message and retry rather than letting the exception propagate.
    let ws: WebSocket;
    try {
      ws = new WebSocket(target);
    } catch {
      this.onLog('Failed to open a connection to the relay: invalid relay URL');
      if (!this.closed) this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('error', () => {
      // The standard WebSocket error event carries no diagnostic detail by design.
      this.onLog('Relay connection error');
    });

    ws.addEventListener('open', () => {
      this.onLog('Connected to relay');
      this.onOpenCallback();
      // The relay accepts the WS upgrade (firing this 'open' event) before it has
      // asynchronously verified the token and can still reject with close code 4401.
      // Only treat the connection as genuinely stable — and reset backoff — if it
      // survives long enough that a same-tick auth rejection would already have closed it.
      this.openConfirmTimer = setTimeout(() => {
        this.backoffMs = this.initialBackoffMs;
      }, this.openConfirmMs);
    });

    ws.addEventListener('message', (messageEvent) => {
      let parsed: RelayMessage;
      try {
        parsed = RelayMessage.parse(JSON.parse(String(messageEvent.data)));
      } catch {
        this.onLog('Received an unparseable frame from the relay');
        return;
      }
      if (parsed.kind === 'event') {
        this.onEvent({ sessionId: parsed.sessionId, seq: parsed.seq, event: parsed.event });
      }
    });

    ws.addEventListener('close', (closeEvent) => {
      if (this.openConfirmTimer) {
        clearTimeout(this.openConfirmTimer);
        this.openConfirmTimer = undefined;
      }
      this.onCloseCallback();
      if (this.closed) return;
      // 4401 (invalid/missing token) and 4403 (device unpaired) mean the token itself is no
      // longer valid — reconnecting with the same token would just repeat the rejection
      // forever. Treat these as terminal instead of retrying.
      if (closeEvent.code === 4401 || closeEvent.code === 4403) {
        this.closed = true;
        this.onUnauthorizedCallback();
        return;
      }
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
