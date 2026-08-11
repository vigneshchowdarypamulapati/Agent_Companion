import { defineConfig } from 'vitest/config';

// Tests need DATABASE_URL (the real Neon project) but .env isn't checked
// in. Loading it here means every `npm test` invocation picks it up
// automatically. Missing .env would just mean tests that need
// DATABASE_URL fail with a clear connection error — not silently skipped.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file present — fine in CI environments that set env vars directly
}

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    // schema.test.ts and postgres-store.test.ts both read/write the same
    // shared live Neon database. Vitest runs test *files* in parallel by
    // default, so without this, postgres-store.test.ts's beforeEach
    // TRUNCATE can race with schema.test.ts's insert-then-read in another
    // worker and wipe rows out from under it. Test files still run their
    // own `it` blocks normally; this only serializes across files so the
    // shared DB never sees concurrent writers.
    fileParallelism: false,
  },
});
