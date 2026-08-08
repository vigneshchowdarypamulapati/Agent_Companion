import '@testing-library/jest-dom/vitest';

// Node ships its own native `localStorage` global, which wins precedence over
// vitest's jsdom environment in this Node/vitest version combination — vitest
// only overrides globals it doesn't already find defined. Point `localStorage`
// at the real Storage instance vitest's jsdom environment already constructed,
// rather than reimplementing the Storage interface (which risks diverging
// from real behavior — e.g. a naive `value || null` getItem incorrectly
// returns null for a stored empty string).
Object.defineProperty(globalThis, 'localStorage', {
  value: (globalThis as unknown as { jsdom: { window: { localStorage: Storage } } }).jsdom.window.localStorage,
  configurable: true,
});
