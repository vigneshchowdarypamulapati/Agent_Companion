import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.js';

// packages/relay/src/db/migrate.ts (or dist/db/migrate.js after build) is
// always two directories below packages/relay/, so '../../drizzle'
// resolves to packages/relay/drizzle/ from either location.
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
