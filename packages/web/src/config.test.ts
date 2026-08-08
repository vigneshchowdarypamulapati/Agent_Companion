import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * config.ts computes its exports at module-evaluation time, so each case has
 * to stub the env and re-import the module fresh.
 */
async function loadConfig(env: { http?: string; ws?: string }) {
  vi.stubEnv('VITE_RELAY_HTTP_URL', env.http ?? '');
  vi.stubEnv('VITE_RELAY_WS_URL', env.ws ?? '');
  vi.resetModules();
  return import('./config');
}

describe('config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('falls back to localhost when neither variable is set', async () => {
    const config = await loadConfig({});
    expect(config.RELAY_HTTP_URL).toBe('http://localhost:8787');
    expect(config.RELAY_WS_URL).toBe('ws://localhost:8787');
  });

  it('derives a wss:// URL from an https:// relay URL when the WS one is unset', async () => {
    const config = await loadConfig({ http: 'https://relay.example.com' });
    expect(config.RELAY_WS_URL).toBe('wss://relay.example.com');
  });

  it('derives a ws:// URL from an http:// relay URL', async () => {
    const config = await loadConfig({ http: 'http://relay.example.com:8080' });
    expect(config.RELAY_WS_URL).toBe('ws://relay.example.com:8080');
  });

  it('honours an explicitly set WS URL', async () => {
    const config = await loadConfig({ http: 'https://relay.example.com', ws: 'wss://ws.example.com' });
    expect(config.RELAY_WS_URL).toBe('wss://ws.example.com');
  });
});
