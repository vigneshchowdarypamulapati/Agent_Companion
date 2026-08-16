import { WebSocket } from 'ws';
import { RelayToDaemonMessage, type Command, type DaemonToRelayMessage, type SessionEvent } from '@companion/protocol';
import { OutboundBuffer, type BufferedEvent } from './outbound-buffer.js';

export interface RelayClientOptions {
  url: string;
  token: string;
  /**
   * `commandId` is forwarded so the caller can reply with `sendCommandAck(commandId, ...)` once
   * dispatch finishes (or throws) — see sendCommandAck's doc comment for how that relates to
   * (and is distinct from) the `command_failed` SessionEvent.
   */
  onCommand: (commandId: string, command: Command) => void;
  onOpen?: () => void;
  onLog?: (message: string) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * How long a connection must stay open before it counts as stable and the
   * reconnect backoff is reset. Defaults to 3000ms.
   */
  openConfirmMs?: number;
  /** Overrides for the outbound buffer's bounds — see outbound-buffer.ts for defaults/rationale. */
  maxBufferedEvents?: number;
  maxBufferedBytes?: number;
}

/**
 * Persistent outbound WebSocket connection from the daemon to the relay.
 * Forwards SessionEvents out, dispatches Commands in, and reconnects with
 * exponential backoff on any disconnect until close() is called.
 */
export class RelayClient {
  private readonly url: string;
  private readonly token: string;
  private readonly onCommand: (commandId: string, command: Command) => void;
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
   * Daemon-assigned delivery sequence, incremented per event handed to sendEvent (including
   * synthesized events_dropped markers — see sendEvent). Distinct from the relay's store-assigned
   * `seq` (which only the relay can assign, once it durably persists the event): this is what the
   * relay's `event_ack` reports back as "highest contiguous deliverySeq stored", and what `buffer`
   * uses to know which buffered entries are still unacknowledged and must be replayed.
   */
  private deliverySeq = 0;
  /**
   * Holds every sent-but-not-yet-acknowledged event so a disconnect never destroys one — see
   * outbound-buffer.ts for the full rationale and bounds. Replayed in full, in order, on every
   * reconnect (openSocket's 'open' handler) before any newly-generated event is sent.
   */
  private readonly buffer: OutboundBuffer;

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
    this.buffer = new OutboundBuffer({
      maxEntries: options.maxBufferedEvents,
      maxBytes: options.maxBufferedBytes,
    });
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

  /**
   * Never silently drops. While disconnected, the event is buffered and replayed on the next
   * reconnect instead of destroyed — see the class-level `buffer` doc and outbound-buffer.ts.
   * If `sessionId` had earlier events evicted from the buffer (overflow), an `events_dropped`
   * marker for it is buffered/sent first, so a consumer never mistakes a gap for a complete
   * history.
   */
  sendEvent(sessionId: string, event: SessionEvent): void {
    if (this.buffer.consumePendingDrop(sessionId)) {
      this.bufferAndTransmit(sessionId, { type: 'events_dropped', sessionId, at: Date.now() });
    }
    this.bufferAndTransmit(sessionId, event);
  }

  private bufferAndTransmit(sessionId: string, event: SessionEvent): void {
    this.deliverySeq += 1;
    const entry: BufferedEvent = { deliverySeq: this.deliverySeq, sessionId, event };
    this.buffer.push(entry);
    this.transmit(entry);
  }

  /** Sends one entry if (and only if) the socket is currently open; otherwise a no-op — the
   * entry stays in `buffer` and goes out on the next replay. */
  private transmit(entry: BufferedEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const message: DaemonToRelayMessage = {
      kind: 'event',
      sessionId: entry.sessionId,
      deliverySeq: entry.deliverySeq,
      event: entry.event,
    };
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Reports the *delivery* outcome of a command back to the relay — 'delivered' once
   * dispatchCommand has been handed the command and returned without throwing, 'failed' with a
   * message if it threw. This is deliberately NOT the same signal as the `command_failed`
   * SessionEvent (sent via sendEvent, see main.ts): that event reports execution failure to
   * every browser watching the session's history, while this ack is a one-shot reply routed
   * back only to the browser that sent this exact commandId, existing purely so that browser
   * can stop showing "sending…" and either clear its input or show a retry affordance. Both are
   * commonly fired from the same catch block for the same underlying error — that's expected,
   * not a duplication to collapse (see CommandAckMessage's doc comment in @companion/protocol).
   *
   * Unlike sendEvent, this is best-effort and NOT buffered/replayed across a disconnect: if the
   * socket isn't open, the ack is simply dropped. That's safe because the browser side owns its
   * own ack timeout (see web's relay-connection.ts) — a lost ack surfaces there as a failure the
   * user can retry, and re-sending a stale ack after a reconnect could race a fresh retry the
   * user already issued under a new commandId.
   */
  sendCommandAck(commandId: string, status: 'delivered' | 'failed', message?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const ackMessage: DaemonToRelayMessage = { kind: 'command_ack', commandId, status, message };
    this.ws.send(JSON.stringify(ackMessage));
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
      // Replay every unacknowledged event before anything newly-generated goes out, so the relay
      // never sees events for a session out of order (e.g. a later event arriving before the
      // session_started that a disconnect had buffered).
      for (const entry of this.buffer.all()) {
        this.transmit(entry);
      }
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
        this.onCommand(parsed.commandId, parsed.command);
      } else if (parsed.kind === 'event_ack') {
        // The relay does not send this yet (that's a later task), but handling it now means
        // nothing else has to change once it does: any acked entries stop being replayed.
        this.buffer.acknowledge(parsed.deliverySeq);
      }
      // 'rpc_request' is not yet handled — RPC dispatch is a later task.
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
