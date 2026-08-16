import { RelayToBrowserMessage, type BrowserToRelayMessage, type Command, type SessionEvent } from '@companion/protocol';

/** The outcome of a command sent via `sendCommand`, reported exactly once per commandId — see
 * `onCommandAck`'s doc comment for how it's produced. */
export interface CommandAckResult {
  status: 'delivered' | 'failed';
  message?: string;
}

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
  /**
   * Fired exactly once per commandId handed out by `sendCommand`, with the outcome — see that
   * method's doc comment for the three ways this can happen (a real ack, a timeout, or the
   * connection being torn down while still pending).
   */
  onCommandAck?: (commandId: string, result: CommandAckResult) => void;
  /**
   * How long `sendCommand` waits for a `command_ack` (whether the command was queued while
   * offline or transmitted immediately) before giving up and reporting 'failed' on its own —
   * see `sendCommand`'s doc comment. Defaults to 10000ms: generous relative to how fast the
   * daemon actually dispatches (see command-dispatcher.ts on the daemon side — dispatch itself
   * is near-instant; it does not wait for a full Claude turn), while still short enough that a
   * phone user is never left staring at "Sending…" indefinitely.
   */
  commandAckTimeoutMs?: number;
}

interface PendingCommand {
  sessionId: string;
  command: Command;
  /** False while the command is queued waiting for a socket to send over; true once it has
   * actually been transmitted at least once. Only ever transmitted once — see `flushQueue`. */
  transmitted: boolean;
  timer: ReturnType<typeof setTimeout>;
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
  private readonly onCommandAckCallback: (commandId: string, result: CommandAckResult) => void;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly openConfirmMs: number;
  private readonly commandAckTimeoutMs: number;
  private ws: WebSocket | undefined;
  private backoffMs: number;
  private closed = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private openConfirmTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Every command handed to `sendCommand` that hasn't yet been resolved (by ack, timeout, or
   * `close()`) — whether still queued because the socket wasn't open, or already transmitted and
   * awaiting a reply. See `sendCommand`'s doc comment for the full lifecycle.
   */
  private readonly pendingCommands = new Map<string, PendingCommand>();

  constructor(options: RelayConnectionOptions) {
    this.url = options.url;
    this.token = options.token;
    this.onEvent = options.onEvent;
    this.onOpenCallback = options.onOpen ?? (() => {});
    this.onCloseCallback = options.onClose ?? (() => {});
    this.onUnauthorizedCallback = options.onUnauthorized ?? (() => {});
    this.onLog = options.onLog ?? (() => {});
    this.onCommandAckCallback = options.onCommandAck ?? (() => {});
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.openConfirmMs = options.openConfirmMs ?? 3000;
    this.commandAckTimeoutMs = options.commandAckTimeoutMs ?? 10_000;
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
    // Every still-outstanding command is reported failed rather than left to dangle silently —
    // whoever called sendCommand (e.g. a still-mounted component in a test, or a caller that
    // doesn't get torn down in lockstep with this connection) is guaranteed exactly one
    // onCommandAck call per commandId no matter how the connection's lifecycle ends.
    for (const [commandId, entry] of this.pendingCommands) {
      clearTimeout(entry.timer);
      this.onCommandAckCallback(commandId, { status: 'failed', message: 'Connection closed before the command was acknowledged' });
    }
    this.pendingCommands.clear();
    this.ws?.close();
  }

  /**
   * Sends a command and returns its client-generated commandId immediately; the actual outcome
   * (delivered/failed) arrives later via `onCommandAck`, exactly once, one of three ways:
   *
   *   1. The relay routes back a real `command_ack` from the daemon (see the 'command_ack'
   *      branch in the message handler below) — the common case.
   *   2. If the socket isn't open right now, the command is queued (not dropped — this is the
   *      fix for the exact regression this exists to prevent: a phone waking from sleep must
   *      never silently lose a typed reply) and transmitted on the next successful reconnect
   *      (see the 'open' handler below). It still counts toward the timeout below while queued,
   *      so a connection that never comes back doesn't leave the caller waiting forever.
   *   3. If nothing above resolves it within `commandAckTimeoutMs`, `failPending` reports
   *      'failed' with a timeout message on its own.
   *
   * Deliberately does NOT retransmit a command that was already sent once but never acked
   * (e.g. sent, then the socket drops before the ack arrives): re-sending on reconnect would
   * risk the daemon dispatching it twice (an injected prompt is not idempotent). Once
   * transmitted, a command's fate is either a real ack or the timeout above — never a retry
   * this class initiates on its own. A caller that wants to retry after a 'failed' result calls
   * sendCommand again, which mints a fresh commandId.
   */
  sendCommand(sessionId: string, command: Command): string {
    const commandId = crypto.randomUUID();
    const timer = setTimeout(() => this.failPending(commandId), this.commandAckTimeoutMs);
    const entry: PendingCommand = { sessionId, command, transmitted: false, timer };
    this.pendingCommands.set(commandId, entry);
    this.transmit(commandId, entry);
    return commandId;
  }

  /** Sends `entry` now if (and only if) the socket is open; otherwise a no-op — it stays queued
   * in `pendingCommands` (with `transmitted` still false) and is retried by `flushQueue`. */
  private transmit(commandId: string, entry: PendingCommand): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.onLog(`Queuing command ${entry.command.type} for session ${entry.sessionId}: not connected to relay`);
      return;
    }
    const message: BrowserToRelayMessage = { kind: 'command', sessionId: entry.sessionId, commandId, command: entry.command };
    this.ws.send(JSON.stringify(message));
    entry.transmitted = true;
  }

  /** Sends every not-yet-transmitted queued command, in the order it was originally submitted.
   * Called once per reconnect, from the 'open' handler. Already-transmitted commands are never
   * touched here — see `sendCommand`'s doc comment for why a sent-but-unacked command is not
   * retried on reconnect. */
  private flushQueue(): void {
    for (const [commandId, entry] of this.pendingCommands) {
      if (!entry.transmitted) this.transmit(commandId, entry);
    }
  }

  private resolvePending(commandId: string, result: CommandAckResult): void {
    const entry = this.pendingCommands.get(commandId);
    // Not found: already resolved (timeout raced a late-arriving ack) or an ack for a commandId
    // this connection never sent — either way, nothing to do.
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingCommands.delete(commandId);
    this.onCommandAckCallback(commandId, result);
  }

  private failPending(commandId: string): void {
    this.resolvePending(commandId, {
      status: 'failed',
      message: 'Timed out waiting for the daemon to acknowledge this command',
    });
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
      // Flush every command that was queued while disconnected before anything
      // newly-generated goes out, mirroring the daemon's own event-replay ordering (see
      // daemon's relay-client.ts) — and before onOpenCallback, so a caller reacting to
      // "connected" never observes a queued-but-not-yet-sent command.
      this.flushQueue();
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
      let parsed: RelayToBrowserMessage;
      try {
        parsed = RelayToBrowserMessage.parse(JSON.parse(String(messageEvent.data)));
      } catch {
        this.onLog('Received an unparseable frame from the relay');
        return;
      }
      if (parsed.kind === 'event') {
        this.onEvent({ sessionId: parsed.sessionId, seq: parsed.seq, event: parsed.event });
      } else if (parsed.kind === 'command_ack') {
        this.resolvePending(parsed.commandId, { status: parsed.status, message: parsed.message });
      }
      // 'rpc_response' is not yet handled — RPC is a later task.
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
