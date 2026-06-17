/**
 * Drizzle client over a lazily-created pg Pool.
 *
 * Uses the pooled (Supabase Supavisor transaction-mode) connection string at
 * runtime and registers the pool with Vercel's Fluid Compute graceful-shutdown
 * hook so idle connections are drained correctly. Migrations use the unpooled
 * (direct) string (see drizzle.config.ts).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { env } from '@/lib/env';
import * as schema from './schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

let _pool: Pool | undefined;
let _db: Db | undefined;

/**
 * Supabase (and Neon) require TLS. We enable it unless the connection string
 * explicitly disables SSL (local Postgres). Some poolers present a certificate
 * chain Node doesn't trust by default — set DATABASE_SSL_NO_VERIFY=1 to connect
 * without strict CA verification if you hit a "self-signed certificate" error.
 */
function sslConfig(connectionString: string): PoolConfig['ssl'] {
  if (/sslmode=disable/i.test(connectionString)) return undefined;
  return { rejectUnauthorized: !env.databaseSslNoVerify() };
}

export function getDb(): Db {
  if (!_db) {
    const connectionString = env.databaseUrl();
    _pool = new Pool({
      connectionString,
      max: 5,
      ssl: sslConfig(connectionString),
    });
    // Keep the function instance alive long enough to drain idle connections.
    attachDatabasePool(_pool);
    _db = drizzle(_pool, { schema });
  }
  return _db;
}

export { schema };
