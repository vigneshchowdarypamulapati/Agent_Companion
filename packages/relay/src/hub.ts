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
  | { kind: 'event'; sessionId: string; event: SessionEvent }
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
  private connections = new Map<string, Connection>();

  constructor(
    private store: Store,
    private pubsub: PubSub
  ) {
    this.pubsub.subscribe(CHANNEL, (message) => this.dispatchLocal(message as PubSubEnvelope));
  }

  register(connection: Connection): void {
    this.connections.set(connection.deviceId, connection);
  }

  unregister(deviceId: string): void {
    this.connections.delete(deviceId);
  }

  async routeFromDaemon(connection: Connection, sessionId: string, event: SessionEvent): Promise<void> {
    if (event.type === 'session_started') {
      await this.store.upsertSession({
        id: sessionId,
        userId: connection.userId,
        daemonDeviceId: connection.deviceId,
        projectPath: event.projectPath,
        status: 'running',
        startedAt: event.at,
      });
    } else {
      const status = STATUS_BY_EVENT_TYPE[event.type];
      if (status) {
        await this.store.updateSessionStatus(sessionId, status);
      }
    }
    await this.store.appendSessionEvent(sessionId, event);
    await this.pubsub.publish(CHANNEL, {
      userId: connection.userId,
      message: { kind: 'event', sessionId, event },
    } satisfies PubSubEnvelope);
  }

  async routeFromBrowser(connection: Connection, sessionId: string, command: Command): Promise<void> {
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
      for (const connection of this.connections.values()) {
        if (connection.userId === envelope.userId && connection.deviceType === 'browser') {
          connection.send(envelope.message);
        }
      }
    } else {
      const target = envelope.targetDeviceId ? this.connections.get(envelope.targetDeviceId) : undefined;
      if (target && target.userId === envelope.userId) {
        target.send(envelope.message);
      }
    }
  }
}
