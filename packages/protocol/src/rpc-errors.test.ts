import { describe, it, expect } from 'vitest';
import { RPC_ERROR_CODES } from './rpc-errors.js';

describe('RPC_ERROR_CODES', () => {
  it('every value is a unique string, so no two codes can ever be confused for each other', () => {
    const values = Object.values(RPC_ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(typeof value).toBe('string');
    }
  });

  it('covers the minimum set of failure reasons the RPC channel must be able to distinguish', () => {
    expect(RPC_ERROR_CODES).toMatchObject({
      NO_DAEMON: 'no_daemon',
      DAEMON_DISCONNECTED: 'daemon_disconnected',
      TIMEOUT: 'timeout',
      UNKNOWN_METHOD: 'unknown_method',
      IN_FLIGHT_CAP_EXCEEDED: 'in_flight_cap_exceeded',
      HANDLER_ERROR: 'handler_error',
      NOT_CONNECTED: 'not_connected',
    });
  });

  it('includes the new session-start error codes', () => {
    expect(RPC_ERROR_CODES.INVALID_PROJECT_PATH).toBe('invalid_project_path');
    expect(RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT).toBe('concurrent_session_limit');
  });
});
