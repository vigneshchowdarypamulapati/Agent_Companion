import type { Command, SessionEvent, SessionStatus } from '@companion/protocol';
import type { Store } from './store.js';
import type { PubSub } from './pubsub.js';

export interface Connection {
  readonly deviceId: string;
  readonly userId: string;
  readonly deviceType: 'daemon' | 'browser';
  send(message: RelayHubMessage): void;
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
  turn_complete: 'running',
  stopped: 'stopped',
  error: 'stopped',
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
    private now: () => number = Date.now
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
   * seq. Runs `graceMs` after the daemon's last connection closes; cancelled by a reconnect within
   * that window (see `register`).
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
