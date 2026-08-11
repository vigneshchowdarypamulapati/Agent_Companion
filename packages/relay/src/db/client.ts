import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createDbClient(connectionString: string): { pool: Pool; db: Db } {
  const pool = new Pool({ connectionString, max: 10 });
  // An 'error' event with no listener is an uncaught exception that kills
  // the process. pg-pool emits this when an idle client's connection dies —
  // exactly what happens when Neon autosuspends the compute after a period
  // of inactivity and a held-open pool connection is next touched.
  pool.on('error', (err) => {
    console.error('Postgres pool error (idle client evicted):', err);
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
