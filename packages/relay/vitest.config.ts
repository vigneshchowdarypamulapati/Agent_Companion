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
  },
});
