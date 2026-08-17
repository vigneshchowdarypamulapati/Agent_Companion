import { PushSubscriptionPayload } from '@companion/protocol';
import type {
  Command,
  CommandAckMessage,
  RelayToBrowserMessage,
  RelayToDaemonMessage,
  SessionEvent,
  SessionStatus,
} from '@companion/protocol';
import type { Store } from './store.js';
import type { PubSub } from './pubsub.js';
import type { PushPayload, PushSender } from './push-sender.js';

export interface Connection {
  readonly deviceId: string;
  readonly userId: string;
  readonly deviceType: 'daemon' | 'browser';
  send(message: RelayHubMessage): void;
  close(): void;
}

/**
 * The hub's internal pub/sub envelope, distinct from the four directional wire-protocol unions
 * in @companion/protocol. It's not itself a wire message in one direction — `dispatchLocal`
 * fans an 'event' out to every browser connection (the same shape as RelayToBrowserMessage's
 * `event` variant), routes a 'command' to the one daemon connection that owns the session
 * (the same shape as RelayToDaemonMessage's `command` variant), and routes a 'command_ack' back
 * to the one browser connection that sent the original command (the same shape as
 * RelayToBrowserMessage's `command_ack` variant) — so no single directional union describes this
 * type on its own. Rather than hand-duplicating those field lists, they're derived from the
 * protocol types with `Extract` — this stays in sync automatically if any variant's shape
 * changes, without coupling RelayHubMessage to the unrelated variants (rpc_request,
 * rpc_response) that appear in those unions but never flow through the hub's internal envelope.
 */
export type RelayHubMessage =
  | Extract<RelayToBrowserMessage, { kind: 'event' }>
  | Extract<RelayToBrowserMessage, { kind: 'command_ack' }>
  | Extract<RelayToDaemonMessage, { kind: 'command' }>
  | Extract<RelayToDaemonMessage, { kind: 'event_ack' }>;

interface PubSubEnvelope {
  userId: string;
  targetDeviceId?: string;
  message: RelayHubMessage;
}

const STATUS_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], SessionStatus>> = {
  permission_request: 'waiting_permission',
  permission_resolved: 'running',
  assistant_text: 'running',
  tool_use: 'running',
  turn_complete: 'waiting_input',
  stopped: 'stopped',
  error: 'stopped',
  // events_dropped: deliberately absent. It reports a gap in the delivered history (events the
  // daemon's outbound buffer had to evict), not a change in what the session is actually doing —
  // the session's real status is whatever the next real event says it is.
};

/**
 * Event types that trigger a push notification, and the notification title for each. A type
 * absent from this map never notifies — this is the single source of truth for "which events
 * are worth waking someone's phone up for" (currently: a permission prompt blocking the
 * session, Claude finishing a turn and waiting on a reply, an error, or the session stopping).
 */
const NOTIFICATION_TITLE_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], string>> = {
  permission_request: 'Needs your permission',
  turn_complete: 'Claude is waiting for you',
  error: 'Session error',
  stopped: 'Session stopped',
  // events_dropped: deliberately absent — it's a bookkeeping marker about missing history, not
  // something happening in the session worth waking someone's phone up for.
};

const CHANNEL = 'relay:message';

/** How long a daemon's sessions stay non-stopped after its last connection drops, before being
 * treated as orphaned. Long enough that a brief network blip or process restart doesn't falsely
 * kill an in-progress session; short enough that a genuinely dead daemon's sessions become
 * dismissable in a reasonable time. */
const DEFAULT_DAEMON_DISCONNECT_GRACE_MS = 30_000;

/**
 * Upper bound on how long a `pendingCommandAcks` entry (see the field's doc comment) is kept
 * around waiting for a `command_ack` that may never come. Deliberately longer than the
 * browser's own ack timeout (web's relay-connection.ts) so a slow-but-genuine ack is never
 * dropped here first — this is only a memory-leak backstop, not the mechanism a phone user's
 * failure/retry UX depends on.
 */
const PENDING_COMMAND_ACK_TTL_MS = 60_000;

export class ConnectionHub {
  /**
   * Connections are keyed by deviceId but stored as a Set, because the same device may hold
   * several simultaneous connections (two browser tabs sharing a token, or a reconnect whose
   * predecessor's `close` event has not fired yet). Unregistering is identity-based so a stale
   * socket's late `close` cannot evict a live one.
   */
  private connections = new Map<string, Set<Connection>>();

  /** Pending grace-period timers, keyed by daemon deviceId. Cancelled by a reconnect (see
   * `register`) before they fire; fires in `stopDaemonSessions` otherwise. */
  private pendingDaemonStops = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Per-daemon-connection ack bookkeeping (see `routeFromDaemon` / `ackDelivery`). Keyed by the
   * `Connection` object itself, not `deviceId`: a fresh object is created on every reconnect
   * (see server.ts), so this naturally starts empty for a new connection rather than needing to
   * be reset by hand — which is exactly right, since a reconnected daemon's replay can
   * legitimately start at any `deliverySeq`, not necessarily 1 (see `ackDelivery`'s doc for why
   * "start at 1" would be the wrong assumption anyway).
   *
   * `ackedThroughDeliverySeq` is the highest `deliverySeq` acked so far. `poisoned` is set the
   * first time a *received* event's `store.appendSessionEvent` call fails on this connection,
   * and once set, this connection never sends another `event_ack` for the rest of its lifetime
   * — see `ackDelivery`'s doc for why a later success must not be allowed to ack past it.
   */
  private daemonAckState = new Map<Connection, { ackedThroughDeliverySeq: number; poisoned: boolean }>();

  /**
   * Per-daemon-connection processing queue: each entry is a promise chain that every
   * `routeFromDaemon` call for that connection appends itself to and awaits, so frames from one
   * daemon connection are always fully processed — validation, the store write, publish, and
   * the resulting ack — one at a time, in the order their frames arrived, never concurrently.
   *
   * This is required, not just nice-to-have: server.ts's `ws.on('message', ...)` handler
   * dispatches each frame as an independent, un-awaited async chain (`void (async () => {...
   * })()`), so without this queue two `event` frames arriving close together — exactly the
   * reconnect-replay burst this whole feature exists to serve — would run their
   * `routeFromDaemon` calls concurrently. Against a real Postgres store, `getSession` /
   * `updateSessionStatus` / `appendSessionEvent` are separate statements/transactions with no
   * cross-call ordering guarantee (see postgres-store.ts): a later `deliverySeq`'s writes could
   * finish and get acked before an earlier one (still in flight) is even known to have
   * succeeded or failed. If that earlier one then failed, the daemon would already have been
   * told it's safe to drop it — permanent, silent event loss, the exact failure mode Task 2
   * exists to prevent. A WebSocket only guarantees frames ARRIVE in order (TCP's guarantee);
   * this queue is what guarantees they are also *processed* in that order, which `ackDelivery`'s
   * safety depends on.
   */
  private daemonProcessingQueues = new Map<Connection, Promise<void>>();

  /**
   * Correlates a browser-originated `commandId` back to the browser device that must receive
   * the eventual `command_ack` — the ack itself (see CommandAckMessage) only carries the
   * commandId and delivery outcome, not who sent the command, so this is the only place that
   * link exists. Populated in `routeFromBrowser`, consumed (and removed) in `routeCommandAck`.
   *
   * In-memory only, like RateLimiter (see rate-limiter.ts) — the relay is a single process
   * today (PubSub itself is in-memory-only, see README.md), so this is exactly as durable as
   * the deployment it serves. A command whose ack never arrives (daemon crashes mid-dispatch,
   * relay restarts) leaks its entry until `pruneExpiredCommandAcks` sweeps it — the browser side
   * has its own ack timeout (see web's relay-connection.ts) and shows a failure independently of
   * whether this entry is ever cleaned up, so nothing user-visible depends on the sweep.
   */
  private pendingCommandAcks = new Map<string, { userId: string; browserDeviceId: string; expiresAt: number }>();

  constructor(
    private store: Store,
    private pubsub: PubSub,
    private graceMs: number = DEFAULT_DAEMON_DISCONNECT_GRACE_MS,
    private now: () => number = Date.now,
    private pushSender?: PushSender
  ) {}

  /** Must be awaited before the hub will receive any routed messages. */
  async start(): Promise<void> {
    await this.pubsub.subscribe(CHANNEL, (message) => this.dispatchLocal(message as PubSubEnvelope));
  }

  register(connection: Connection): void {
    const set = this.connections.get(connection.deviceId) ?? new Set<Connection>();
    set.add(connection);
    this.connections.set(connection.deviceId, set);

    if (connection.deviceType === 'daemon') {
      const pending = this.pendingDaemonStops.get(connection.deviceId);
      if (pending) {
        clearTimeout(pending);
        this.pendingDaemonStops.delete(connection.deviceId);
      }
    }
  }

  unregister(connection: Connection): void {
    // Not gated on the connection still being present in `connections` below: it's harmless to
    // delete a key that was never inserted (no ack was ever sent), and this keeps ack-state
    // cleanup unconditional rather than one more thing a future refactor of the block below
    // could accidentally skip. Deleting `daemonProcessingQueues` here is pure hygiene, not a
    // cancellation — any in-flight entries in that chain keep running against the now-closed
    // `connection` to completion (harmless: no further `routeFromDaemon` calls for this
    // connection object can happen once its socket is closed, so nothing new appends to it).
    this.daemonAckState.delete(connection);
    this.daemonProcessingQueues.delete(connection);

    const set = this.connections.get(connection.deviceId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.connections.delete(connection.deviceId);
      if (connection.deviceType === 'daemon') {
        this.scheduleDaemonStop(connection.deviceId, connection.userId);
      }
    }
  }

  /**
   * Force-closes every live connection currently authenticated as `deviceId`, and removes
   * them from the hub immediately rather than waiting for the transport's own close handling
   * to get around to it. `ws.close()` performs a graceful close handshake with up to a 30s
   * timeout before the socket is actually destroyed — without an immediate `unregister()`
   * here, a revoked device could keep receiving live session events for up to 30s after
   * "revocation." Calling `unregister()` here is safe even though the WebSocket 'close'
   * handler in server.ts also calls it once the socket actually closes: `unregister()`
   * no-ops if the connection is already gone from its deviceId's set, so that later call is
   * a harmless no-op. (Mutating the Set via `unregister` while iterating it here is also
   * safe — deleting the current element during a for-of over a Set does not skip or revisit
   * any other element.)
   */
  disconnectDevice(deviceId: string): void {
    const set = this.connections.get(deviceId);
    if (!set) return;
    for (const connection of set) {
      connection.close();
      this.unregister(connection);
    }
  }

  private scheduleDaemonStop(deviceId: string, userId: string): void {
    const timer = setTimeout(() => {
      this.pendingDaemonStops.delete(deviceId);
      void this.stopDaemonSessions(deviceId, userId);
    }, this.graceMs);
    this.pendingDaemonStops.set(deviceId, timer);
  }

  /**
   * Marks every non-stopped session owned by a now-fully-disconnected daemon as stopped, the same
   * way a genuine `stopped` event from that daemon would be handled: store status updated, event
   * appended to the session's log, broadcast live to the user's browsers with a store-assigned
   * seq, AND a push notification sent the same way a genuine `stopped` event routed through
   * routeFromDaemon would — a crashed daemon is exactly the kind of unexpected stop worth
   * notifying about. Runs `graceMs` after the daemon's last connection closes; cancelled by a
   * reconnect within that window (see `register`).
   */
  private async stopDaemonSessions(deviceId: string, userId: string): Promise<void> {
    try {
      const sessions = await this.store.getActiveSessionsForUser(userId);
      const orphaned = sessions.filter((s) => s.daemonDeviceId === deviceId && s.status !== 'stopped');
      for (const session of orphaned) {
        const event: SessionEvent = { type: 'stopped', sessionId: session.id, at: this.now() };
        await this.store.updateSessionStatus(session.id, 'stopped');
        const stored = await this.store.appendSessionEvent(session.id, event);
        await this.pubsub.publish(CHANNEL, {
          userId,
          message: { kind: 'event', sessionId: session.id, seq: stored.seq, event },
        } satisfies PubSubEnvelope);
        await this.notifyPush(userId, session.id, event.type, stored.seq);
      }
    } catch {
      // Best-effort cleanup running detached from any request/connection — a store or pubsub
      // failure here must not crash the relay process.
    }
  }

  private allConnections(): Connection[] {
    return [...this.connections.values()].flatMap((set) => [...set]);
  }

  /**
   * `deliverySeq` is optional only so every pre-existing call site in tests (which predate
   * event acking and don't care about it) keeps compiling unchanged; every real caller
   * (server.ts) always passes it, since every DaemonToRelayMessage `event` frame carries one.
   *
   * Every call for a given `connection` is chained onto that connection's entry in
   * `daemonProcessingQueues` and awaited before `processDaemonEvent` actually runs — see that
   * field's doc for why serialization (not just "start the work") is required here. The chain
   * itself is built from `.then(ok, ok)` so one call's rejection never poisons the *queue* for
   * the next call (each frame still gets processed on its own turn), while the promise handed
   * back to *this* call's own caller (`result`, returned below) still resolves/rejects exactly
   * the way `processDaemonEvent` for this specific frame did — server.ts's per-message catch
   * block still sees the real error and still sends a real `{kind:'error'}` frame for it.
   */
  async routeFromDaemon(connection: Connection, sessionId: string, event: SessionEvent, deliverySeq?: number): Promise<void> {
    const previousTurn = this.daemonProcessingQueues.get(connection) ?? Promise.resolve();
    const thisTurn = previousTurn.then(
      () => this.processDaemonEvent(connection, sessionId, event, deliverySeq),
      () => this.processDaemonEvent(connection, sessionId, event, deliverySeq)
    );
    this.daemonProcessingQueues.set(
      connection,
      thisTurn.then(
        () => undefined,
        () => undefined
      )
    );
    return thisTurn;
  }

  /** The actual per-frame work `routeFromDaemon` serializes — see that method's doc. Never call
   * this directly; always go through `routeFromDaemon` so ordering is enforced. */
  private async processDaemonEvent(connection: Connection, sessionId: string, event: SessionEvent, deliverySeq?: number): Promise<void> {
    if (event.sessionId !== sessionId) {
      throw new Error('Envelope sessionId does not match event payload sessionId');
    }

    if (event.type === 'session_started') {
      const existing = await this.store.getSession(sessionId);
      if (existing && existing.daemonDeviceId !== connection.deviceId) {
        throw new Error(`Session ${sessionId} is already owned by a different daemon`);
      }
      await this.store.upsertSession({
        id: sessionId,
        userId: connection.userId,
        daemonDeviceId: connection.deviceId,
        projectPath: event.projectPath,
        status: 'running',
        startedAt: event.at,
        lastEventAt: event.at,
        dismissed: false,
      });
    } else {
      // Verify ownership for non-session_started events
      const session = await this.store.getSession(sessionId);
      if (!session || session.daemonDeviceId !== connection.deviceId) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      const status = STATUS_BY_EVENT_TYPE[event.type];
      if (status) {
        await this.store.updateSessionStatus(sessionId, status);
      }
    }

    let stored;
    try {
      stored = await this.store.appendSessionEvent(sessionId, event);
    } catch (err) {
      // A *received* event whose store write failed — as opposed to an envelope/ownership
      // rejection above, which never reached the store at all. See markDeliveryFailed's doc for
      // why this specifically (and only this) permanently freezes this connection's ack.
      if (deliverySeq !== undefined) this.markDeliveryFailed(connection);
      throw err;
    }

    await this.pubsub.publish(CHANNEL, {
      userId: connection.userId,
      message: { kind: 'event', sessionId, seq: stored.seq, event },
    } satisfies PubSubEnvelope);

    await this.notifyPush(connection.userId, sessionId, event.type, stored.seq);

    // Only reached once appendSessionEvent above has actually succeeded — if it throws, this
    // line never runs and no ack is sent. That's what makes the ack a durability signal ("this
    // is stored, stop buffering it") rather than a mere receipt. See ackDelivery's doc for why
    // the acked value doesn't need to be an unbroken 1..N run.
    if (deliverySeq !== undefined) {
      this.ackDelivery(connection, deliverySeq);
    }
  }

  /**
   * Sends `event_ack` for the highest `deliverySeq` durably stored so far on this connection —
   * deliberately NOT "the highest *contiguous* deliverySeq starting from 1," even though that's
   * the more literal reading of "ack the highest contiguous value" this feature is often
   * described with. That literal reading breaks in practice:
   *
   * The daemon's OutboundBuffer (see daemon's outbound-buffer.ts) evicts old entries under
   * memory pressure. An evicted `deliverySeq` is gone forever — the daemon has no copy left to
   * ever send — so if the relay insisted on an unbroken run before advancing its ack, the very
   * first overflow would permanently wedge the ack at the last value before the gap, and the
   * daemon would re-send (and the relay would re-store, since acknowledge() in the daemon's
   * buffer only drops entries <= the acked value) every event after that gap forever.
   *
   * The fix relies on two facts:
   *   1. A WebSocket delivers messages in order and without loss while the connection stays
   *      open — TCP already guarantees that, and neither endpoint reorders or drops frames on
   *      top of it. So any gap this method ever observes between successive `deliverySeq`
   *      values on one connection is not a transport loss; it is the daemon itself having
   *      already dropped those entries (buffer eviction) before ever sending them.
   *   2. The daemon already knows about that gap independently (`OutboundBuffer.push` marks the
   *      session for an `events_dropped` event – see outbound-buffer.ts) — the ack's job is
   *      only to stop the daemon re-sending what it *did* send and the relay *did* store, not
   *      to somehow account for what the daemon already gave up on.
   *
   * That reasoning covers gaps caused by the *daemon* deciding not to send something. It does
   * NOT cover a `deliverySeq` the daemon DID send and the relay DID receive, whose store write
   * then failed (`processDaemonEvent`'s catch, `markDeliveryFailed`) — the relay has no
   * independent confirmation the daemon knows to give up on that one, because it doesn't; it's
   * still sitting in the daemon's OutboundBuffer waiting to be acked. Acking a later, higher
   * `deliverySeq` past it would tell the daemon it's safe to drop that still-unstored entry too
   * (`OutboundBuffer.acknowledge` drops everything `<=` the acked value) — silent, permanent
   * loss of data the relay never actually persisted. So `ackDelivery` is gap-tolerant only for
   * *unreceived* gaps; once a *received* event fails to store, `daemonAckState.poisoned` is set
   * (`markDeliveryFailed`) and this method becomes a permanent no-op for that connection — even
   * for later `deliverySeq` values whose own store write succeeds. The only way that entry can
   * ever actually reach the relay again is a fresh connection replaying the daemon's still-full
   * buffer from scratch (see relay-client.ts's reconnect replay), which is exactly the case this
   * deliberately waits for instead of guessing it's safe to move on.
   *
   * This safety depends on `routeFromDaemon` serializing frames per connection (see
   * `daemonProcessingQueues`): only because a lower `deliverySeq`'s outcome is always fully known
   * before a higher one is even attempted can "the first failure permanently freezes" be
   * expressed as a simple flag, rather than needing to reason about which of several
   * concurrently in-flight writes might still fail.
   */
  private ackDelivery(connection: Connection, deliverySeq: number): void {
    const state = this.daemonAckState.get(connection) ?? { ackedThroughDeliverySeq: 0, poisoned: false };
    if (state.poisoned) return;
    state.ackedThroughDeliverySeq = Math.max(state.ackedThroughDeliverySeq, deliverySeq);
    this.daemonAckState.set(connection, state);
    connection.send({ kind: 'event_ack', deliverySeq: state.ackedThroughDeliverySeq });
  }

  /** See `ackDelivery`'s doc for why a store failure for a received event permanently freezes
   * this connection's ack rather than just skipping the one failed value. */
  private markDeliveryFailed(connection: Connection): void {
    const state = this.daemonAckState.get(connection) ?? { ackedThroughDeliverySeq: 0, poisoned: false };
    state.poisoned = true;
    this.daemonAckState.set(connection, state);
  }

  async routeFromBrowser(connection: Connection, sessionId: string, commandId: string, command: Command): Promise<void> {
    if (command.type === 'start_session') {
      throw new Error('start_session cannot be routed through the relay');
    }
    if (command.sessionId !== sessionId) {
      throw new Error('Envelope sessionId does not match command payload sessionId');
    }
    const session = await this.store.getSession(sessionId);
    if (!session || session.userId !== connection.userId) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    this.pruneExpiredCommandAcks();
    // Recorded before publishing so routeCommandAck can find it even if the daemon's ack
    // (routed back through pubsub, possibly processed by this same synchronous tick in the
    // in-memory pubsub implementation) arrives unexpectedly fast.
    this.pendingCommandAcks.set(commandId, {
      userId: connection.userId,
      browserDeviceId: connection.deviceId,
      expiresAt: this.now() + PENDING_COMMAND_ACK_TTL_MS,
    });
    await this.pubsub.publish(CHANNEL, {
      userId: connection.userId,
      targetDeviceId: session.daemonDeviceId,
      message: { kind: 'command', sessionId, commandId, command },
    } satisfies PubSubEnvelope);
  }

  /**
   * Routes a daemon's `command_ack` (delivery outcome — see CommandAckMessage's doc comment for
   * why this is distinct from the `command_failed` SessionEvent, which reports the dispatched
   * command later *throwing*, not delivery itself) back to the one browser device that sent the
   * originating command, using the correlation recorded in `routeFromBrowser`.
   *
   * An unknown `commandId` (already routed once, already expired, or never recorded because
   * this relay process restarted between the command and its ack) is silently ignored: the ack
   * has nowhere left to go, and the browser's own ack timeout is what actually guarantees the
   * user sees a result either way — this is best-effort delivery on top of that guarantee, not
   * the guarantee itself.
   */
  async routeCommandAck(connection: Connection, ack: CommandAckMessage): Promise<void> {
    this.pruneExpiredCommandAcks();
    const pending = this.pendingCommandAcks.get(ack.commandId);
    // The userId check is defense in depth, not the primary safeguard: commandIds are
    // client-generated UUIDs, so a different user's daemon guessing one is not a realistic
    // attack, but there is no reason to route an ack cross-account if it ever happened.
    if (!pending || pending.userId !== connection.userId) return;
    this.pendingCommandAcks.delete(ack.commandId);
    await this.pubsub.publish(CHANNEL, {
      userId: pending.userId,
      targetDeviceId: pending.browserDeviceId,
      message: { kind: 'command_ack', commandId: ack.commandId, status: ack.status, message: ack.message },
    } satisfies PubSubEnvelope);
  }

  private pruneExpiredCommandAcks(): void {
    const now = this.now();
    for (const [commandId, entry] of this.pendingCommandAcks) {
      if (entry.expiresAt <= now) this.pendingCommandAcks.delete(commandId);
    }
  }

  /**
   * Sends a push notification to every one of `userId`'s browser devices that has a stored
   * push subscription, for a qualifying event type (see NOTIFICATION_TITLE_BY_EVENT_TYPE).
   * Deliberately called from routeFromDaemon and stopDaemonSessions (each runs once per event,
   * on whichever relay instance actually processed it) rather than from dispatchLocal (runs
   * once per relay instance subscribed to the pubsub channel) — sending from dispatchLocal
   * would fire a duplicate push per relay instance in a horizontally-scaled deployment. Every
   * failure mode here — no matching title, no session, an individual device's send failing, a
   * store failure — is swallowed: push delivery is best-effort and must never affect event
   * routing or crash the process.
   *
   * `device.pushSubscription` is re-validated with `PushSubscriptionPayload.safeParse`
   * immediately before every send, not trusted as-is from the store. `POST
   * /devices/push-subscription` only validates on the way in, and only for subscriptions
   * written *after* that validation existed — any row written earlier (or by some future
   * write path that forgets to validate) would otherwise be POSTed to unchanged, which is
   * exactly the SSRF primitive the ingress validation exists to close, now carrying up to 140
   * characters of assistant text as the POST body. A subscription that fails re-validation is
   * treated the same as the existing `'gone'` case — cleared via `setPushSubscription`, never
   * sent to — which is self-healing (the browser will re-subscribe and overwrite it) and needs
   * no separate backfill migration or operator step.
   */
  private async notifyPush(userId: string, sessionId: string, eventType: SessionEvent['type'], currentSeq: number): Promise<void> {
    if (!this.pushSender) return;
    const title = NOTIFICATION_TITLE_BY_EVENT_TYPE[eventType];
    if (!title) return;
    try {
      const session = await this.store.getSession(sessionId);
      if (!session) return;
      const devices = await this.store.getDevicesForUser(userId);
      const targets = devices.filter((d) => d.type === 'browser' && d.pushSubscription);
      const body = eventType === 'turn_complete' ? await this.lastAssistantTextOrProjectPath(sessionId, session.projectPath, currentSeq) : session.projectPath;
      const payload: PushPayload = { title, body, url: `/sessions/${sessionId}` };
      await Promise.all(
        targets.map(async (device) => {
          try {
            const revalidated = PushSubscriptionPayload.safeParse(device.pushSubscription);
            if (!revalidated.success) {
              // Stored before endpoint validation existed (or written by some other path that
              // skipped it): never send to it, and clear it so the browser re-subscribes.
              await this.store.setPushSubscription(device.id, undefined);
              return;
            }
            const result = await this.pushSender!.send(revalidated.data, payload);
            if (result === 'gone') {
              await this.store.setPushSubscription(device.id, undefined);
            }
          } catch {
            // A single device's push failure must not affect other devices or the caller.
          }
        })
      );
    } catch {
      // Push notification delivery is best-effort and must never affect event routing.
    }
  }

  private async lastAssistantTextOrProjectPath(sessionId: string, projectPath: string, currentSeq: number): Promise<string> {
    const previousTurnComplete = await this.store.getLastEventOfType(sessionId, 'turn_complete', currentSeq);
    const lastAssistantText = await this.store.getLastEventOfType(sessionId, 'assistant_text', currentSeq);
    if (!lastAssistantText || lastAssistantText.event.type !== 'assistant_text') return projectPath;
    if (previousTurnComplete && previousTurnComplete.seq > lastAssistantText.seq) return projectPath;
    const text = lastAssistantText.event.text;
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  }

  private dispatchLocal(envelope: PubSubEnvelope): void {
    if (envelope.message.kind === 'event') {
      for (const connection of this.allConnections()) {
        if (connection.userId === envelope.userId && connection.deviceType === 'browser') {
          connection.send(envelope.message);
        }
      }
    } else {
      const targets = envelope.targetDeviceId ? this.connections.get(envelope.targetDeviceId) : undefined;
      for (const target of targets ?? []) {
        if (target.userId === envelope.userId) {
          target.send(envelope.message);
        }
      }
    }
  }
}
