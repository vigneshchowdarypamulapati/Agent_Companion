import { describe, it, expect } from 'vitest';
import { Command } from './commands.js';

describe('Command schema', () => {
  it('accepts a valid start_session command', () => {
    const result = Command.safeParse({
      type: 'start_session',
      projectPath: '/tmp/project',
      prompt: 'do the thing',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid respond_to_permission command', () => {
    const result = Command.safeParse({
      type: 'respond_to_permission',
      sessionId: 'abc',
      requestId: 'req-1',
      approved: false,
      reason: 'too risky',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a stop command missing sessionId', () => {
    const result = Command.safeParse({ type: 'stop' });
    expect(result.success).toBe(false);
  });
});
