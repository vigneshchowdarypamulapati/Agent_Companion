import { WebSocket } from 'ws';
import { RelayToDaemonMessage, type Command, type DaemonToRelayMessage, type SessionEvent } from '@companion/protocol';

export interface RelayClientOptions {
  url: string;
  token: string;
  onCommand: (command: Command) => void;
  onOpen?: () => void;
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
  private readonly openConfirmMs: number;
  private ws: WebSocket | undefined;
  private backoffMs: number;
  private closed = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private openConfirmTimer: NodeJS.Timeout | undefined;
  /**
   * Daemon-assigned delivery sequence, incremented per event sent. This is distinct from the
   * relay's store-assigned `seq` (which only the relay can assign, once it durably persists the
   * event) — it exists so the relay can eventually ack "highest contiguous deliverySeq stored"
   * and the daemon can redeliver from there. Redelivery/buffering itself is a later task; today
   * this counter just replaces the previous meaningless `seq: 0` placeholder with a real,
   * monotonically increasing value.
   */
  private deliverySeq = 0;

  constructor(options: RelayClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.onCommand = options.onCommand;
    this.onOpenCallback = options.onOpen ?? (() => {});
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

  sendEvent(sessionId: string, event: SessionEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.onLog(`Dropping event ${event.type} for session ${sessionId}: not connected to relay`);
      return;
    }
    this.deliverySeq += 1;
    const message: DaemonToRelayMessage = { kind: 'event', sessionId, deliverySeq: this.deliverySeq, event };
    this.ws.send(JSON.stringify(message));
  }

  private openSocket(): void {
    const base = `${this.url.replace(/\/$/, '')}/ws`;
    const separator = base.includes('?') ? '&' : '?';
    const target = `${base}${separator}token=${encodeURIComponent(this.token)}`;

    // A malformed COMPANION_RELAY_URL makes the WebSocket constructor throw
    // synchronously, and its message quotes the whole URL — token included. Log a
    // sanitized message instead of letting that exception escape into a log line.
    let ws: WebSocket;
    try {
      ws = new WebSocket(target);
    } catch {
      this.onLog('Failed to open a connection to the relay: invalid COMPANION_RELAY_URL');
      if (!this.closed) this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    // Attached before any other listener: an 'error' event with no listener is an
    // uncaught exception that terminates the process.
    ws.on('error', (err) => {
      this.onLog(`Relay connection error: ${err.message}`);
    });

    ws.on('open', () => {
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

    ws.on('message', (raw) => {
      let parsed: RelayToDaemonMessage;
      try {
        parsed = RelayToDaemonMessage.parse(JSON.parse(raw.toString()));
      } catch {
        this.onLog('Received an unparseable frame from the relay');
        return;
      }
      if (parsed.kind === 'command') {
        this.onCommand(parsed.command);
      }
      // 'event_ack' and 'rpc_request' are not yet handled — buffering/redelivery and RPC
      // dispatch are later tasks (see the deliverySeq comment above and the brief).
    });

    ws.on('close', () => {
      if (this.openConfirmTimer) {
        clearTimeout(this.openConfirmTimer);
        this.openConfirmTimer = undefined;
      }
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
