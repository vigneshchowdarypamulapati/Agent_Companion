import type { Command, SessionEvent, SessionStatus } from '@companion/protocol';
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

export type RelayHubMessage =
  | { kind: 'event'; sessionId: string; seq: number; event: SessionEvent }
  | { kind: 'command'; sessionId: string; command: Command };

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
};

const CHANNEL = 'relay:message';

/** How long a daemon's sessions stay non-stopped after its last connection drops, before being
 * treated as orphaned. Long enough that a brief network blip or process restart doesn't falsely
 * kill an in-progress session; short enough that a genuinely dead daemon's sessions become
 * dismissable in a reasonable time. */
const DEFAULT_DAEMON_DISCONNECT_GRACE_MS = 30_000;

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

  async routeFromDaemon(connection: Connection, sessionId: string, event: SessionEvent): Promise<void> {
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

    const stored = await this.store.appendSessionEvent(sessionId, event);
    await this.pubsub.publish(CHANNEL, {
      userId: connection.userId,
      message: { kind: 'event', sessionId, seq: stored.seq, event },
    } satisfies PubSubEnvelope);

    await this.notifyPush(connection.userId, sessionId, event.type, stored.seq);
  }

  async routeFromBrowser(connection: Connection, sessionId: string, command: Command): Promise<void> {
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
    await this.pubsub.publish(CHANNEL, {
      userId: connection.userId,
      targetDeviceId: session.daemonDeviceId,
      message: { kind: 'command', sessionId, command },
    } satisfies PubSubEnvelope);
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
            const result = await this.pushSender!.send(device.pushSubscription!, payload);
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
