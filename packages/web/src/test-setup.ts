import '@testing-library/jest-dom/vitest';

// Node ships its own native `localStorage` global, which wins precedence over
// vitest's jsdom environment in this Node/vitest version combination — vitest
// only overrides globals it doesn't already find defined. Point `localStorage`
// at the real Storage instance vitest's jsdom environment already constructed,
// rather than reimplementing the Storage interface (which risks diverging
// from real behavior — e.g. a naive `value || null` getItem incorrectly
// returns null for a stored empty string).
//
// Only applies when running under the jsdom environment (globalThis.jsdom is
// set by vitest's jsdom environment setup). Test files that override to the
// node environment (e.g. relay-connection.test.ts, via a
// `// @vitest-environment node` comment) don't have globalThis.jsdom at all,
// and don't use localStorage, so this is a no-op there rather than a crash.
const jsdomGlobal = (globalThis as unknown as { jsdom?: { window: { localStorage: Storage } } }).jsdom;
if (jsdomGlobal) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: jsdomGlobal.window.localStorage,
    configurable: true,
  });
}
