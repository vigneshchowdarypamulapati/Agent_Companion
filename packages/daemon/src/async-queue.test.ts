import { describe, it, expect } from 'vitest';
import { AsyncQueue } from './async-queue.js';

describe('AsyncQueue', () => {
  it('yields pushed values in order when closed after pushing', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();

    const received: number[] = [];
    for await (const v of q) {
      received.push(v);
    }
    expect(received).toEqual([1, 2]);
  });

  it('resolves a pending consumer when a value is pushed later', async () => {
    const q = new AsyncQueue<string>();
    const iterator = q[Symbol.asyncIterator]();
    const pending = iterator.next();

    q.push('hello');

    const result = await pending;
    expect(result).toEqual({ value: 'hello', done: false });
  });

  it('throws if pushed to after close', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.push(1)).toThrow();
  });
});
