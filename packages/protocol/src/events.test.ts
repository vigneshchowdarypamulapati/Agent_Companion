import { describe, it, expect } from 'vitest';
import { SessionEvent } from './events.js';

describe('SessionEvent schema', () => {
  it('accepts a valid session_started event', () => {
    const result = SessionEvent.safeParse({
      type: 'session_started',
      sessionId: 'abc',
      projectPath: '/tmp/project',
      at: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid permission_request event', () => {
    const result = SessionEvent.safeParse({
      type: 'permission_request',
      sessionId: 'abc',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      at: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid command_failed event', () => {
    const result = SessionEvent.safeParse({
      type: 'command_failed',
      sessionId: 'abc',
      message: 'No session with id abc',
      at: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a command_failed missing message', () => {
    const result = SessionEvent.safeParse({
      type: 'command_failed',
      sessionId: 'abc',
      at: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an event with an unknown type', () => {
    const result = SessionEvent.safeParse({
      type: 'not_a_real_event',
      sessionId: 'abc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a permission_request missing requestId', () => {
    const result = SessionEvent.safeParse({
      type: 'permission_request',
      sessionId: 'abc',
      toolName: 'Bash',
      input: {},
      at: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid adopted_history event', () => {
    const result = SessionEvent.safeParse({
      type: 'adopted_history',
      sessionId: 'new-session-1',
      originalSessionId: 'original-session-1',
      messages: [
        { role: 'user', text: 'fix the bug in auth.ts' },
        { role: 'assistant', text: 'Found it — the token check was inverted.' },
      ],
      truncated: false,
      at: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts an adopted_history event with an empty messages array', () => {
    const result = SessionEvent.safeParse({
      type: 'adopted_history',
      sessionId: 'new-session-1',
      originalSessionId: 'original-session-1',
      messages: [],
      truncated: false,
      at: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an adopted_history event with an invalid message role', () => {
    const result = SessionEvent.safeParse({
      type: 'adopted_history',
      sessionId: 'new-session-1',
      originalSessionId: 'original-session-1',
      messages: [{ role: 'system', text: 'not a valid role here' }],
      truncated: false,
      at: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an adopted_history event missing truncated', () => {
    const result = SessionEvent.safeParse({
      type: 'adopted_history',
      sessionId: 'new-session-1',
      originalSessionId: 'original-session-1',
      messages: [],
      at: Date.now(),
    });
    expect(result.success).toBe(false);
  });
});
