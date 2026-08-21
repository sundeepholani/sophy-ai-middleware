/**
 * Drizzle client over a lazily-created pg Pool.
 *
 * Uses the Azure PgBouncer connection string at runtime and registers the pool
 * with Vercel's Fluid Compute graceful-shutdown hook. Migrations use the direct
 * Azure connection string (see drizzle.config.ts).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { env } from '@/lib/env';
import { buildDatabasePoolConfig } from './pool-config';
import * as schema from './schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

let _pool: Pool | undefined;
let _db: Db | undefined;

export function getDb(): Db {
  if (!_db) {
    const connectionString = env.databaseUrl();
    _pool = new Pool(
      buildDatabasePoolConfig({
        connectionString,
        max: env.databasePoolMax(),
        isProduction: env.isProd(),
        allowInsecureTls: env.databaseSslNoVerify(),
        expectedHostSuffix: env.databaseExpectedHostSuffix(),
      }),
    );
    // Keep the function instance alive long enough to drain idle connections.
    attachDatabasePool(_pool);
    _db = drizzle(_pool, { schema });
  }
  return _db;
}

export { schema };
