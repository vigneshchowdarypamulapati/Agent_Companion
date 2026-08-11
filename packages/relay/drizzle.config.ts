import { defineConfig } from 'drizzle-kit';

// .env isn't checked in, so drizzle-kit CLI invocations (which don't go
// through vitest.config.ts's own loadEnvFile call) need to load it here
// too. Missing .env is fine — real deployments set DATABASE_URL directly.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file present — fine in production
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run drizzle-kit — see packages/relay/.env.example');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
