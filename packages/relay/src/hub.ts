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

export class ConnectionHub {
  /**
   * Connections are keyed by deviceId but stored as a Set, because the same device may hold
   * several simultaneous connections (two browser tabs sharing a token, or a reconnect whose
   * predecessor's `close` event has not fired yet). Unregistering is identity-based so a stale
   * socket's late `close` cannot evict a live one.
   */
  private connections = new Map<string, Set<Connection>>();

  constructor(
    private store: Store,
    private pubsub: PubSub
  ) {}

  /** Must be awaited before the hub will receive any routed messages. */
  async start(): Promise<void> {
    await this.pubsub.subscribe(CHANNEL, (message) => this.dispatchLocal(message as PubSubEnvelope));
  }

  register(connection: Connection): void {
    const set = this.connections.get(connection.deviceId) ?? new Set<Connection>();
    set.add(connection);
    this.connections.set(connection.deviceId, set);
  }

  unregister(connection: Connection): void {
    const set = this.connections.get(connection.deviceId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.connections.delete(connection.deviceId);
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
