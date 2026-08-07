import type { PubSub } from './pubsub.js';

export class InMemoryPubSub implements PubSub {
  private handlers = new Map<string, Set<(message: unknown) => void>>();

  async publish(channel: string, message: unknown): Promise<void> {
    for (const handler of this.handlers.get(channel) ?? []) {
      handler(message);
    }
  }

  subscribe(channel: string, handler: (message: unknown) => void): void {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
  }
}
