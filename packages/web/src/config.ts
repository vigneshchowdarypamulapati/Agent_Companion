/**
 * Relay endpoints, baked in at build time by Vite.
 *
 * The two URLs are deliberately not independent: a deploy that sets only
 * VITE_RELAY_HTTP_URL used to leave the WebSocket pointing at
 * ws://localhost:8787, which an https:// page blocks as mixed content — the
 * app then sits on "reconnecting…" forever with no explanation. So the WS URL
 * is derived from the HTTP one unless it is explicitly set. An empty string
 * counts as unset (`??` alone would accept it), which is what an unsubstituted
 * or blank .env entry produces.
 */
function readEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https:')) return `wss:${httpUrl.slice('https:'.length)}`;
  if (httpUrl.startsWith('http:')) return `ws:${httpUrl.slice('http:'.length)}`;
  return httpUrl;
}

const httpUrl = readEnv(import.meta.env.VITE_RELAY_HTTP_URL);
const wsUrl = readEnv(import.meta.env.VITE_RELAY_WS_URL);

export const RELAY_HTTP_URL: string = httpUrl ?? 'http://localhost:8787';
export const RELAY_WS_URL: string = wsUrl ?? (httpUrl ? deriveWsUrl(httpUrl) : 'ws://localhost:8787');
