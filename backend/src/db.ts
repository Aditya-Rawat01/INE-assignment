import type { PoolConfig } from 'pg';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

function poolConfig(): PoolConfig {
  const url = process.env.DB_POOLER_URI;
  if (!url) throw new Error('DB_POOLER_URI missing');
  return {
    connectionString: url,
    max: 5,
    ssl: { rejectUnauthorized: false },
    // PgBouncer transaction mode: no prepared statements
    // (node-postgres only prepares on explicit query config; drizzle stays unnamed)
  };
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) pool = new Pool(poolConfig());
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}
