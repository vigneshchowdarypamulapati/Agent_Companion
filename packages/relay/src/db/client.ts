import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createDbClient(connectionString: string): { pool: Pool; db: Db } {
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
