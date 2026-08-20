import {
  RelayToBrowserMessage,
  RPC_ERROR_CODES,
  type BrowserToRelayMessage,
  type Command,
  type RpcErrorCode,
  type SessionEvent,
} from '@companion/protocol';

/** The outcome of a command sent via `sendCommand`, reported exactly once per commandId — see
 * `onCommandAck`'s doc comment for how it's produced. */
export interface CommandAckResult {
  status: 'delivered' | 'failed';
  message?: string;
}

/**
 * Thrown (as a rejection) by `callDaemon` for every failure mode. Callers switch on `.code`
 * (one of RPC_ERROR_CODES) to decide what to render — `.message` is human-readable filler for a
 * generic fallback UI, not something to parse. The wire itself never carries prose (see
 * RpcResponseMessage in @companion/protocol's relay.ts) — `.message` is filled in locally, here,
 * from RPC_ERROR_MESSAGES, for both wire-delivered codes and the purely-local ones
 * (not_connected, timeout) so there's exactly one place this text lives.
 */
export class RpcError extends Error {
  constructor(
    public readonly code: RpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * Default human-readable text for every RpcErrorCode, used to construct the RpcError a caller of
 * `callDaemon` actually catches. Centralized so the UI never has to duplicate this mapping itself,
 * and so a code arriving from the wire (no_daemon, daemon_disconnected, unknown_method,
 * in_flight_cap_exceeded, handler_error — none of which carry any text of their own) gets exactly
 * the same treatment as one produced entirely on this side (not_connected, timeout).
 */
export const RPC_ERROR_MESSAGES: Record<RpcErrorCode, string> = {
  [RPC_ERROR_CODES.NO_DAEMON]: 'No daemon is paired with this account.',
  [RPC_ERROR_CODES.DAEMON_DISCONNECTED]: 'Your daemon is not currently connected.',
  [RPC_ERROR_CODES.TIMEOUT]: 'No response from the daemon in time.',
  [RPC_ERROR_CODES.UNKNOWN_METHOD]: 'This daemon does not support that request. Try reloading the page.',
  [RPC_ERROR_CODES.IN_FLIGHT_CAP_EXCEEDED]: 'Too many pending requests — try again in a moment.',
  [RPC_ERROR_CODES.HANDLER_ERROR]: 'The daemon failed to handle that request.',
  [RPC_ERROR_CODES.INVALID_PROJECT_PATH]: "That project folder couldn't be found. It may have moved or been deleted — try picking again.",
  [RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT]: "You've reached the limit of concurrent sessions. Stop one before starting another.",
  [RPC_ERROR_CODES.SESSION_NOT_FOUND]: "That session isn't available to adopt anymore. Try picking another.",
  [RPC_ERROR_CODES.NOT_CONNECTED]: 'Not connected to the relay.',
};

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
  /**
   * How long the connection can go without receiving *any* frame from the relay (an event, a
   * command_ack — anything) before `checkLiveness` stops trusting `readyState === OPEN` and
   * forces a fresh connection. Browsers auto-reply to the relay's ws-level ping frames (see
   * hub.ts's heartbeat) without ever surfacing them to JS, so a socket a phone held while
   * asleep can read OPEN indefinitely after the underlying network path is gone — this is the
   * only way to catch that. Defaults to 15000ms: well under the ~60s the relay allows before it
   * gives up on a silent connection (two missed 30s ping cycles), but long enough that a
   * session sitting idle between events doesn't look "stale" on its own — checkLiveness only
   * ever runs in response to an explicit visibilitychange/online signal, never on a timer, so a
   * merely-idle-but-healthy connection is never disturbed while the tab stays foregrounded.
   */
  livenessProbeThresholdMs?: number;
  /**
   * How long `callDaemon` waits for an `rpc_response` before rejecting with a TIMEOUT RpcError on
   * its own. Deliberately shorter than the relay's own PENDING_RPC_REQUEST_TTL_MS (hub.ts) — same
   * reasoning as `commandAckTimeoutMs` vs. PENDING_COMMAND_ACK_TTL_MS: the relay-side entry is a
   * memory-safety backstop, not the mechanism a caller's timeout UX depends on, so this has to be
   * the one that actually fires first. Defaults to 8000ms: shorter than `commandAckTimeoutMs`'s
   * 10000ms default, because every RPC method is expected to answer from local, already-available
   * daemon state (see rpc-handlers.ts's `ping`) rather than wait on real work the way a command's
   * dispatch sometimes does — there's no "still working on it" phase to leave room for.
   */
  rpcTimeoutMs?: number;
}

interface PendingCommand {
  sessionId: string;
  command: Command;
  /** False while the command is queued waiting for a socket to send over; true once it has
   * actually been transmitted at least once. Only ever transmitted once — see `flushQueue`. */
  transmitted: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: RpcError) => void;
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
  private readonly livenessProbeThresholdMs: number;
  private readonly rpcTimeoutMs: number;
  private ws: WebSocket | undefined;
  private backoffMs: number;
  private closed = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private openConfirmTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set on 'open' and on every inbound frame — see `checkLiveness`. */
  private lastActivityAt: number | undefined;
  /**
   * Set by `checkLiveness` just before it closes a socket it no longer trusts, so the 'close'
   * handler knows to reopen immediately (bypassing backoff and its jitter) instead of treating
   * this like an ordinary drop. Cleared as soon as that reopen happens.
   */
  private forcingReconnect = false;
  /**
   * Every command handed to `sendCommand` that hasn't yet been resolved (by ack, timeout, or
   * `close()`) — whether still queued because the socket wasn't open, or already transmitted and
   * awaiting a reply. See `sendCommand`'s doc comment for the full lifecycle.
   */
  private readonly pendingCommands = new Map<string, PendingCommand>();
  /** Every call to `callDaemon` that hasn't yet settled — by response, timeout, or `close()`.
   * Unlike `pendingCommands`, nothing is ever queued here while offline (see `callDaemon`'s doc
   * comment for why an RPC — a question whose answer would be stale by the time a queued request
   * finally went out — is not a candidate for the command queue's offline-durability treatment). */
  private readonly pendingRpcs = new Map<string, PendingRpc>();

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
    this.livenessProbeThresholdMs = options.livenessProbeThresholdMs ?? 15_000;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 8_000;
    this.backoffMs = this.initialBackoffMs;
  }

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  /**
   * Called by the caller (see use-relay-connection.ts) when it has independent evidence worth
   * acting on: the tab just became visible again, or the device just regained network
   * connectivity. Neither of those proves the socket is dead, but both are exactly the moments
   * a dead-but-OPEN socket (see `livenessProbeThresholdMs`'s doc comment) would otherwise sit
   * undetected for a long time, and a phone user staring at a stale screen right after unlocking
   * their phone is the whole reason this class exists — so this always errs toward reconnecting
   * rather than waiting for more proof.
   *
   * Two independent cases:
   *   - Socket reads OPEN: only reconnect if genuinely stale (see `livenessProbeThresholdMs`) —
   *     a socket that has heard from the relay recently is trusted as-is.
   *   - Socket is not OPEN (mid-backoff after a real drop): jump the queue and retry right now
   *     instead of waiting out whatever backoff delay is still pending. If nothing is pending
   *     (still in the middle of the very first connect attempt) there is nothing to jump ahead
   *     of, so this is a no-op.
   */
  checkLiveness(): void {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const idleMs = Date.now() - (this.lastActivityAt ?? 0);
      if (idleMs < this.livenessProbeThresholdMs) return;
      this.onLog(
        `No data from the relay in ${idleMs}ms — treating the connection as dead and forcing a reconnect`
      );
      this.backoffMs = this.initialBackoffMs;
      this.forcingReconnect = true;
      this.ws.close();
      return;
    }
    if (!this.reconnectTimer) return;
    this.onLog('Regained connectivity — retrying the relay connection now instead of waiting out the backoff');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.backoffMs = this.initialBackoffMs;
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
    // Every still-outstanding RPC is rejected the same way, for the same reason: `callDaemon`'s
    // promise must always settle, no matter how this connection's lifecycle ends.
    for (const entry of this.pendingRpcs.values()) {
      clearTimeout(entry.timer);
      entry.reject(new RpcError(RPC_ERROR_CODES.NOT_CONNECTED, RPC_ERROR_MESSAGES[RPC_ERROR_CODES.NOT_CONNECTED]));
    }
    this.pendingRpcs.clear();
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

  /**
   * Sends a device-scoped RPC request (see relay.ts's RpcRequestMessage doc — this is the seam
   * for questions that aren't about any existing session, e.g. "what sessions could I adopt?")
   * and resolves once the daemon answers, or rejects with a typed RpcError.
   *
   * Unlike `sendCommand`, this deliberately does NOT queue while the socket is closed: a command
   * represents typed user input this app has promised never to lose, but an RPC is a question
   * whose answer would already be stale by the time a connection that comes back minutes later
   * finally sent it — so a closed socket rejects immediately with NOT_CONNECTED instead of
   * waiting. For the same reason, a request that *was* transmitted is never retried on reconnect
   * (mirroring `sendCommand`'s own non-retry, for the same reason `flushQueue` never touches an
   * already-transmitted command) — its promise either resolves from a real response or rejects on
   * `rpcTimeoutMs`, whichever comes first.
   */
  callDaemon(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new RpcError(RPC_ERROR_CODES.NOT_CONNECTED, RPC_ERROR_MESSAGES[RPC_ERROR_CODES.NOT_CONNECTED]));
        return;
      }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => this.failRpc(requestId), this.rpcTimeoutMs);
      this.pendingRpcs.set(requestId, { resolve, reject, timer });
      // `params` defaults to `null`, not left `undefined`. Note this is NOT for schema reasons:
      // `params: z.unknown()` makes the key optional in zod, so a frame omitting it validates
      // fine either way. It is so the wire shape is the same whether or not a caller passed
      // params — a handler (and anyone reading a captured frame) sees an explicit `null` rather
      // than having to distinguish "absent" from "present but undefined", a distinction
      // JSON.stringify erases anyway by dropping undefined-valued keys.
      const message: BrowserToRelayMessage = { kind: 'rpc_request', requestId, method, params: params ?? null };
      this.ws.send(JSON.stringify(message));
    });
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
    // Deliberately does not claim the command failed to reach the daemon — it may well have:
    // the daemon can dispatch a command and still never get its ack back to us (its own socket
    // closed at the wrong instant, or the relay's correlation entry was lost to a restart — see
    // hub.ts's pendingCommandAcks doc comment), in which case this really is a false-negative
    // timeout, not a real failure. Retry is still the right affordance (never leave the user
    // stuck with unsent text), but the copy has to leave room for "this may have already gone
    // through" so the user can judge whether retrying risks a duplicate before tapping it.
    this.resolvePending(commandId, {
      status: 'failed',
      message: "No response from the daemon in time — it may have already received this. Retry only if you don't see it take effect.",
    });
  }

  private resolveRpc(requestId: string, response: { result?: unknown; error?: string }): void {
    const entry = this.pendingRpcs.get(requestId);
    // Not found: already settled (timeout raced a late-arriving response) or a response for a
    // requestId this connection never sent — either way, nothing to do.
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingRpcs.delete(requestId);
    if (response.error !== undefined) {
      // Every producer of this field on the wire (the relay, this codebase's own daemon) only
      // ever writes one of RPC_ERROR_CODES — see that module's doc comment — so this cast is safe
      // in practice; RPC_ERROR_MESSAGES falls back to the raw string if it's ever wrong.
      const code = response.error as RpcErrorCode;
      entry.reject(new RpcError(code, RPC_ERROR_MESSAGES[code] ?? response.error));
      return;
    }
    entry.resolve(response.result);
  }

  private failRpc(requestId: string): void {
    const entry = this.pendingRpcs.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingRpcs.delete(requestId);
    entry.reject(new RpcError(RPC_ERROR_CODES.TIMEOUT, RPC_ERROR_MESSAGES[RPC_ERROR_CODES.TIMEOUT]));
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
      this.lastActivityAt = Date.now();
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
      // Recorded even for a frame that fails to parse below — the point is only to prove the
      // socket is still receiving *something* from the relay, which an unparseable frame does
      // just as well as a valid one.
      this.lastActivityAt = Date.now();
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
      } else if (parsed.kind === 'rpc_response') {
        this.resolveRpc(parsed.requestId, { result: parsed.result, error: parsed.error });
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
      if (this.forcingReconnect) {
        this.forcingReconnect = false;
        this.openSocket();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, jitter(this.backoffMs));
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }
}

/**
 * Equal jitter (delay is uniformly random in [ms/2, ms]) applied at the moment a reconnect is
 * scheduled — the stored backoff itself still grows on a clean exponential curve. Without this,
 * every client that dropped at the same instant (e.g. a whole household's phones waking from
 * sleep together, or the relay itself restarting) retries in lockstep and re-hits the relay in
 * synchronized spikes instead of a spread-out trickle.
 */
// Exported solely so relay-connection.test.ts can pin Math.random() and assert this formula
// directly, rather than sampling real draws and checking a statistical property of the output —
// this codebase has already been bitten once by that pattern (a chi-squared test, unseeded, that
// flaked in CI) and isn't repeating it here.
export function jitter(ms: number): number {
  return ms / 2 + Math.random() * (ms / 2);
}
