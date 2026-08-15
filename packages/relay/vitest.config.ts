import { defineConfig } from 'vitest/config';

// Tests read env vars from packages/relay/.env, which isn't checked in:
// DATABASE_URL for tests that intentionally share the real dev Neon
// project, and COMPANION_TEST_DATABASE_URL — a separate, isolated Neon
// branch — for postgres-store.test.ts, which truncates its tables before
// every test case and deliberately refuses to run against DATABASE_URL
// (see the guard at the top of that file). Loading .env here means every
// `npm test` invocation picks both vars up automatically. Missing .env
// just means whichever test needs a given var fails with a clear,
// actionable error — never a silent skip.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file present — fine in CI environments that set env vars directly
}

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    // schema.test.ts (DATABASE_URL) and postgres-store.test.ts
    // (COMPANION_TEST_DATABASE_URL) are expected to point at separate Neon
    // databases once the latter is configured, but kept serialized anyway
    // as cheap insurance: if they were ever pointed at the same database —
    // or DATABASE_URL is left unset and something falls back unexpectedly —
    // postgres-store.test.ts's beforeEach TRUNCATE could otherwise race
    // with schema.test.ts's insert-then-read in another worker and wipe
    // rows out from under it. Test files still run their own `it` blocks
    // normally; this only serializes across files.
    fileParallelism: false,
  },
});
