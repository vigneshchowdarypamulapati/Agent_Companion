/**
 * A small, neutral color set dedicated to project-identity dots — deliberately separate from the
 * app's semantic Tailwind tokens (--color-accent, --color-warning, --color-danger, --color-success
 * in index.css). Those mean something (attention needed, an error, success); reusing them here
 * would make a project's dot look like a status indicator by accident. Chosen to read clearly
 * against the app's dark canvas (#201a16) and panel (#2d2521) backgrounds.
 */
export const PROJECT_COLOR_PALETTE = ['#5b8ba8', '#8a6fa8', '#5a9e7d', '#c98a4b', '#a85f7a', '#6f9e5e'] as const;

/** A simple, fast, non-cryptographic string hash (djb2) — collision resistance across ~dozens of
 * project paths is more than sufficient here; this is a decorative dot, not a security boundary. */
function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

/** Deterministic: the same path always maps to the same palette entry, so a project's dot stays
 * consistent across the dashboard without any server-side color assignment or stored state. */
export function colorForProject(path: string): string {
  const index = hashString(path) % PROJECT_COLOR_PALETTE.length;
  return PROJECT_COLOR_PALETTE[index];
}
