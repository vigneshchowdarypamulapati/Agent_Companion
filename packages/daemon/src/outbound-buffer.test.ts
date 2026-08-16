import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@companion/protocol';
import { OutboundBuffer } from './outbound-buffer.js';

function turnComplete(sessionId: string, deliverySeq: number): { deliverySeq: number; sessionId: string; event: SessionEvent } {
  return { deliverySeq, sessionId, event: { type: 'turn_complete', sessionId, at: deliverySeq } };
}

describe('OutboundBuffer', () => {
  it('holds pushed entries and replays them in order via all()', () => {
    const buffer = new OutboundBuffer();
    buffer.push(turnComplete('s1', 1));
    buffer.push(turnComplete('s1', 2));
    buffer.push(turnComplete('s2', 3));

    expect(buffer.all().map((e) => e.deliverySeq)).toEqual([1, 2, 3]);
    expect(buffer.size).toBe(3);
  });

  it('acknowledge() drops the contiguous prefix up to and including the given deliverySeq', () => {
    const buffer = new OutboundBuffer();
    buffer.push(turnComplete('s1', 1));
    buffer.push(turnComplete('s1', 2));
    buffer.push(turnComplete('s1', 3));

    buffer.acknowledge(2);

    expect(buffer.all().map((e) => e.deliverySeq)).toEqual([3]);
  });

  it('acknowledge() is a no-op when nothing in the buffer is old enough', () => {
    const buffer = new OutboundBuffer();
    buffer.push(turnComplete('s1', 5));

    buffer.acknowledge(2);

    expect(buffer.all().map((e) => e.deliverySeq)).toEqual([5]);
  });

  it('evicts the oldest entry once the entry-count bound is exceeded, and flags its session', () => {
    const buffer = new OutboundBuffer({ maxEntries: 2 });
    buffer.push(turnComplete('s1', 1));
    buffer.push(turnComplete('s1', 2));
    buffer.push(turnComplete('s1', 3));

    expect(buffer.all().map((e) => e.deliverySeq)).toEqual([2, 3]);
    expect(buffer.consumePendingDrop('s1')).toBe(true);
  });

  it('evicts the oldest entries once the byte-size bound is exceeded, and flags their session', () => {
    // Each turn_complete event serializes to a small, fixed number of bytes; size the cap to
    // fit exactly two of them so the third push forces one eviction.
    const single = Buffer.byteLength(JSON.stringify(turnComplete('s1', 1).event), 'utf8');
    const buffer = new OutboundBuffer({ maxBytes: single * 2 });

    buffer.push(turnComplete('s1', 1));
    buffer.push(turnComplete('s1', 2));
    buffer.push(turnComplete('s1', 3));

    expect(buffer.all().map((e) => e.deliverySeq)).toEqual([2, 3]);
    expect(buffer.consumePendingDrop('s1')).toBe(true);
  });

  it('only flags the session whose entries were actually evicted', () => {
    const buffer = new OutboundBuffer({ maxEntries: 2 });
    buffer.push(turnComplete('s1', 1)); // evicted
    buffer.push(turnComplete('s2', 2));
    buffer.push(turnComplete('s2', 3));

    expect(buffer.consumePendingDrop('s1')).toBe(true);
    expect(buffer.consumePendingDrop('s2')).toBe(false);
  });

  it('consumePendingDrop() is idempotent: true once, then false until the next eviction', () => {
    const buffer = new OutboundBuffer({ maxEntries: 1 });
    buffer.push(turnComplete('s1', 1));
    buffer.push(turnComplete('s1', 2)); // evicts deliverySeq 1

    expect(buffer.consumePendingDrop('s1')).toBe(true);
    expect(buffer.consumePendingDrop('s1')).toBe(false);

    buffer.push(turnComplete('s1', 3)); // evicts deliverySeq 2
    expect(buffer.consumePendingDrop('s1')).toBe(true);
  });

  it('a single entry larger than maxBytes is itself evicted and its session flagged', () => {
    const buffer = new OutboundBuffer({ maxBytes: 4 });
    buffer.push(turnComplete('s1', 1));

    expect(buffer.all()).toEqual([]);
    expect(buffer.consumePendingDrop('s1')).toBe(true);
  });
});
