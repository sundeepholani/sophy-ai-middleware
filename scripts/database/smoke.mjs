import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  databaseIdentity,
  requiredDatabaseUrl,
  secureConnectionConfig,
} from './connection.mjs';

const { Client } = pg;
const migrationJournal = JSON.parse(
  await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
);
const expectedMigrationCount = migrationJournal.entries.length;
const expectedApplicationRole = process.env.TARGET_APPLICATION_ROLE ?? 'sophy_app';
const expectedMigrationRole = process.env.TARGET_MIGRATION_ROLE ?? 'sophy_migrator';
const targetUrl = requiredDatabaseUrl('TARGET_DATABASE_URL');
const migrationUrl = requiredDatabaseUrl('TARGET_DATABASE_URL_UNPOOLED');
if (databaseIdentity(targetUrl) !== databaseIdentity(migrationUrl)) {
  throw new Error('Target application and migration URLs identify different databases.');
}
const target = new Client(
  secureConnectionConfig(targetUrl, {
    label: 'Target database',
    allowInsecureTls: false,
    applicationName: 'sophy-db-smoke',
    expectedHostSuffix: 'postgres.database.azure.com',
    expectedPort: 6432,
  }),
);
const migration = new Client(
  secureConnectionConfig(migrationUrl, {
    label: 'Target migration database',
    allowInsecureTls: false,
    applicationName: 'sophy-db-smoke-migration',
    expectedHostSuffix: 'postgres.database.azure.com',
    expectedPort: 5432,
  }),
);

let failed = false;
try {
  await Promise.all([target.connect(), migration.connect()]);
  await target.query('BEGIN');
  await target.query("SET LOCAL lock_timeout = '5s'");
  const role = await target.query(`
    SELECT
      r.rolname,
      session_user AS session_role,
      r.rolsuper,
      r.rolcreaterole,
      r.rolcreatedb,
      r.rolreplication,
      r.rolbypassrls,
      pg_has_role(r.oid, owner.oid, 'MEMBER') AS owns_schema,
      has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create_in_public,
      has_schema_privilege(r.oid, 'drizzle', 'USAGE') AS can_use_drizzle
    FROM pg_roles r
    JOIN pg_roles owner ON owner.rolname = 'sophy_owner'
    WHERE r.rolname = current_user
  `);
  const tlsSocket = target.connection.stream;
  const tlsVerified = tlsSocket.encrypted === true && tlsSocket.authorized === true;
  const ledger = await migration.query(
    'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
  );
  const migrationRole = await migration.query(`
    SELECT
      login_role.rolname AS login_role,
      current_user AS effective_role,
      login_role.rolsuper,
      login_role.rolcreaterole,
      login_role.rolcreatedb,
      login_role.rolreplication,
      login_role.rolbypassrls,
      pg_has_role(login_role.oid, owner.oid, 'SET') AS can_set_owner
    FROM pg_roles login_role
    JOIN pg_roles owner ON owner.rolname = 'sophy_owner'
    WHERE login_role.rolname = session_user
  `);
  const ownership = await migration.query(`
    SELECT
      (
        SELECT pg_get_userbyid(datdba) = 'sophy_owner'
        FROM pg_database
        WHERE datname = current_database()
      ) AS database_owned,
      (
        SELECT count(*) = 2 AND bool_and(pg_get_userbyid(nspowner) = 'sophy_owner')
        FROM pg_namespace
        WHERE nspname IN ('public', 'drizzle')
      ) AS schemas_owned,
      (
        SELECT count(*) > 0 AND bool_and(pg_get_userbyid(c.relowner) = 'sophy_owner')
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'drizzle')
          AND c.relkind IN ('r', 'p', 'S', 'i')
      ) AS relations_owned
  `);
  const migrationTlsSocket = migration.connection.stream;
  const vector = await target.query(`
    SELECT
      vector_dims(array_fill(0::real, ARRAY[1536])::vector) AS dimensions,
      EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.relname = 'kb_chunks_embedding_hnsw'
          AND t.relname = 'kb_chunks'
          AND n.nspname = 'public'
          AND i.indisvalid
      ) AS hnsw_valid
  `);
  await target.query(`
    CREATE TEMPORARY TABLE sophy_vector_smoke (
      id integer PRIMARY KEY,
      embedding vector(3) NOT NULL
    ) ON COMMIT DROP
  `);
  await target.query(`
    INSERT INTO sophy_vector_smoke (id, embedding)
    VALUES (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0,0,1]')
  `);
  await target.query(
    'CREATE INDEX sophy_vector_smoke_hnsw ON sophy_vector_smoke USING hnsw (embedding vector_cosine_ops)',
  );
  await target.query('SET LOCAL enable_seqscan = off');
  const vectorSearch = await target.query(`
    SELECT id
    FROM sophy_vector_smoke
    ORDER BY embedding <=> '[0.9,0.1,0]'::vector
    LIMIT 1
  `);
  const lock = await target.query(
    "SELECT pg_try_advisory_xact_lock(hashtextextended('sophy-migration-smoke', 0)) AS acquired",
  );

  const bucket = `migration-smoke:${randomUUID()}`;
  await target.query(
    'INSERT INTO public.rate_counters (bucket, window_start, count) VALUES ($1, $2, 1)',
    [bucket, Date.now()],
  );
  const updated = await target.query(
    'UPDATE public.rate_counters SET count = count + 1 WHERE bucket = $1 RETURNING count',
    [bucket],
  );
  const lockedRow = await target.query(
    'SELECT count FROM public.rate_counters WHERE bucket = $1 FOR UPDATE SKIP LOCKED',
    [bucket],
  );
  await target.query('DELETE FROM public.rate_counters WHERE bucket = $1', [bucket]);

  const checks = {
    restrictedRole:
      role.rows.length === 1 &&
      role.rows[0].rolname === expectedApplicationRole &&
      role.rows[0].session_role === expectedApplicationRole &&
      !role.rows[0].rolsuper &&
      !role.rows[0].rolcreaterole &&
      !role.rows[0].rolcreatedb &&
      !role.rows[0].rolreplication &&
      !role.rows[0].rolbypassrls &&
      !role.rows[0].owns_schema &&
      !role.rows[0].can_create_in_public &&
      !role.rows[0].can_use_drizzle,
    tls: tlsVerified,
    migrationTls:
      migrationTlsSocket.encrypted === true && migrationTlsSocket.authorized === true,
    migrationRole:
      migrationRole.rows.length === 1 &&
      migrationRole.rows[0].login_role === expectedMigrationRole &&
      migrationRole.rows[0].effective_role === 'sophy_owner' &&
      !migrationRole.rows[0].rolsuper &&
      !migrationRole.rows[0].rolcreaterole &&
      !migrationRole.rows[0].rolcreatedb &&
      !migrationRole.rows[0].rolreplication &&
      !migrationRole.rows[0].rolbypassrls &&
      migrationRole.rows[0].can_set_owner === true,
    ownership:
      ownership.rows[0]?.database_owned === true &&
      ownership.rows[0]?.schemas_owned === true &&
      ownership.rows[0]?.relations_owned === true,
    drizzleLedger: ledger.rows[0]?.count === expectedMigrationCount,
    vectorDimensions: vector.rows[0]?.dimensions === 1536,
    hnswIndex: vector.rows[0]?.hnsw_valid === true,
    hnswSearch: vectorSearch.rows[0]?.id === 1,
    advisoryLock: lock.rows[0]?.acquired === true,
    transactionCrud: updated.rows[0]?.count === 2 && lockedRow.rows[0]?.count === 2,
  };
  failed = Object.values(checks).some((value) => !value);
  console.log(JSON.stringify({ ok: !failed, checks }, null, 2));
} finally {
  await Promise.allSettled([target.query('ROLLBACK')]);
  await Promise.allSettled([target.end(), migration.end()]);
}

if (failed) process.exitCode = 1;
