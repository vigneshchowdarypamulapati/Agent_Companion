import { describe, it, expect, vi } from 'vitest';
import { InMemoryPubSub } from './in-memory-pubsub.js';

describe('InMemoryPubSub', () => {
  it('delivers a published message to a subscribed handler', async () => {
    const pubsub = new InMemoryPubSub();
    const handler = vi.fn();
    await pubsub.subscribe('channel-a', handler);

    await pubsub.publish('channel-a', { hello: 'world' });

    expect(handler).toHaveBeenCalledWith({ hello: 'world' });
  });

  it('delivers to every subscriber on the same channel', async () => {
    const pubsub = new InMemoryPubSub();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    await pubsub.subscribe('channel-a', handlerA);
    await pubsub.subscribe('channel-a', handlerB);

    await pubsub.publish('channel-a', 'ping');

    expect(handlerA).toHaveBeenCalledWith('ping');
    expect(handlerB).toHaveBeenCalledWith('ping');
  });

  it('does not deliver to a handler on a different channel', async () => {
    const pubsub = new InMemoryPubSub();
    const handler = vi.fn();
    await pubsub.subscribe('channel-a', handler);

    await pubsub.publish('channel-b', 'ping');

    expect(handler).not.toHaveBeenCalled();
  });

  it('publishing with no subscribers does not throw', async () => {
    const pubsub = new InMemoryPubSub();
    await expect(pubsub.publish('channel-a', 'ping')).resolves.toBeUndefined();
  });

  it('unsubscribe stops delivery to that handler only', async () => {
    const pubsub = new InMemoryPubSub();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    await pubsub.subscribe('channel-a', handlerA);
    await pubsub.subscribe('channel-a', handlerB);

    await pubsub.unsubscribe('channel-a', handlerA);
    await pubsub.publish('channel-a', 'ping');

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledWith('ping');
  });

  it('unsubscribing an unknown handler or channel does not throw', async () => {
    const pubsub = new InMemoryPubSub();
    await expect(pubsub.unsubscribe('channel-a', vi.fn())).resolves.toBeUndefined();
  });
});
