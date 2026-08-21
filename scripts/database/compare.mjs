import pg from 'pg';
import { readFile } from 'node:fs/promises';
import {
  databaseIdentity,
  requiredDatabaseUrl,
  secureConnectionConfig,
} from './connection.mjs';

const { Client } = pg;
const SCHEMAS = ['drizzle', 'public'];
const EXPECTED_TABLE_COUNT = 23;
const DEEP = process.argv.includes('--deep');

const sourceUrl = requiredDatabaseUrl('SOURCE_DATABASE_URL');
const targetUrl = requiredDatabaseUrl('TARGET_DATABASE_URL');
const sourceCa = process.env.SOURCE_DATABASE_CA_FILE
  ? await readFile(process.env.SOURCE_DATABASE_CA_FILE, 'utf8')
  : undefined;
if (databaseIdentity(sourceUrl) === databaseIdentity(targetUrl)) {
  throw new Error('Source and target database URLs identify the same database.');
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function schemaState(client) {
  const result = await client.query(
    `
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        md5(concat_ws('|',
          coalesce((
            SELECT string_agg(
              concat_ws(':',
                a.attname,
                format_type(a.atttypid, a.atttypmod),
                a.attnotnull::text,
                a.attidentity,
                a.attgenerated,
                a.attcollation::regcollation::text,
                coalesce(pg_get_expr(d.adbin, d.adrelid), '')
              ),
              ',' ORDER BY a.attnum
            )
            FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          ), ''),
          coalesce((
            SELECT string_agg(
              con.conname || ':' || pg_get_constraintdef(con.oid, true),
              ',' ORDER BY con.conname
            )
            FROM pg_constraint con
            WHERE con.conrelid = c.oid
          ), ''),
          coalesce((
            SELECT string_agg(
              pg_get_indexdef(i.indexrelid),
              ',' ORDER BY pg_get_indexdef(i.indexrelid)
            )
            FROM pg_index i
            WHERE i.indrelid = c.oid
          ), ''),
          c.relrowsecurity::text,
          c.relreplident::text
        )) AS schema_hash,
        bool_and(coalesce(i.indisvalid, true)) AS indexes_valid,
        bool_and(coalesce(con.convalidated, true)) AS constraints_valid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_index i ON i.indrelid = c.oid
      LEFT JOIN pg_constraint con ON con.conrelid = c.oid
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
      GROUP BY n.nspname, c.relname, c.oid, c.relrowsecurity, c.relreplident
      ORDER BY n.nspname, c.relname
    `,
    [SCHEMAS],
  );
  return result.rows;
}

async function primaryKeyColumns(client, schemaName, tableName) {
  const result = await client.query(
    `
      SELECT a.attname
      FROM pg_index i
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, position) ON true
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2
      ORDER BY k.position
    `,
    [schemaName, tableName],
  );
  return result.rows.map((row) => row.attname);
}

async function tableState(client, table) {
  const columns = await primaryKeyColumns(client, table.schema_name, table.table_name);
  if (columns.length === 0) {
    throw new Error(`Table ${table.schema_name}.${table.table_name} has no primary key.`);
  }

  const relation = `${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)}`;
  const keyJson = `jsonb_build_array(${columns
    .map((column) => `t.${quoteIdentifier(column)}`)
    .join(', ')})::text`;
  const deepColumns = DEEP
    ? `,
       coalesce(bit_xor(hashtextextended(to_jsonb(t)::text, 17)), 0)::text AS row_hash_1,
       coalesce(bit_xor(hashtextextended(to_jsonb(t)::text, 97)), 0)::text AS row_hash_2`
    : '';
  const result = await client.query(
    `
      SELECT
        count(*)::text AS row_count,
        coalesce(bit_xor(hashtextextended(${keyJson}, 17)), 0)::text AS key_hash_1,
        coalesce(bit_xor(hashtextextended(${keyJson}, 97)), 0)::text AS key_hash_2
        ${deepColumns}
      FROM ${relation} t
    `,
  );
  return result.rows[0];
}

async function requestLogDays(client) {
  const result = await client.query(`
    SELECT
      created_at::date::text AS day,
      count(*)::text AS row_count,
      coalesce(bit_xor(hashtextextended(id::text, 17)), 0)::text AS key_hash
    FROM public.request_logs
    GROUP BY created_at::date
    ORDER BY created_at::date
  `);
  return result.rows;
}

async function extensionState(client) {
  const result = await client.query(
    `SELECT extname, extversion, extnamespace::regnamespace::text AS schema_name
     FROM pg_extension WHERE extname = 'vector'`,
  );
  return result.rows[0] ?? null;
}

async function sequenceState(client) {
  const definitions = await client.query(
    `SELECT
       schemaname AS schema_name,
       sequencename AS sequence_name,
       start_value::text,
       min_value::text,
       max_value::text,
       increment_by::text,
       cycle,
       cache_size::text,
       last_value::text,
       (
         SELECT format('%I.%I.%I', table_namespace.nspname, table_class.relname, attribute.attname)
         FROM pg_class sequence_class
         JOIN pg_namespace sequence_namespace ON sequence_namespace.oid = sequence_class.relnamespace
         JOIN pg_depend dependency
           ON dependency.classid = 'pg_class'::regclass
          AND dependency.objid = sequence_class.oid
          AND dependency.deptype = 'a'
         JOIN pg_class table_class ON table_class.oid = dependency.refobjid
         JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
         JOIN pg_attribute attribute
           ON attribute.attrelid = table_class.oid
          AND attribute.attnum = dependency.refobjsubid
         WHERE sequence_namespace.nspname = pg_sequences.schemaname
           AND sequence_class.relname = pg_sequences.sequencename
       ) AS owned_by
     FROM pg_sequences
     WHERE schemaname = ANY($1)
     ORDER BY schemaname, sequencename`,
    [SCHEMAS],
  );
  const ledger = await client.query(
    `SELECT last_value::text, is_called
     FROM drizzle.__drizzle_migrations_id_seq`,
  );
  return { definitions: definitions.rows, ledger: ledger.rows[0] };
}

async function databaseState(client) {
  const result = await client.query(`
    SELECT
      (current_setting('server_version_num')::integer / 10000) AS server_major,
      pg_encoding_to_char(d.encoding) AS encoding,
      d.datlocprovider AS locale_provider,
      d.datlocale AS icu_locale,
      d.datcollate AS lc_collate,
      d.datctype AS lc_ctype,
      current_setting('TimeZone') AS time_zone,
      d.datcollversion AS configured_collation_version,
      pg_database_collation_actual_version(d.oid) AS actual_collation_version
    FROM pg_database d
    WHERE d.datname = current_database()
  `);
  return result.rows[0];
}

async function unsupportedObjectState(client) {
  const result = await client.query(
    `SELECT
       (SELECT count(*)::integer
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND (c.relrowsecurity OR c.relforcerowsecurity)) AS rls_tables,
       (SELECT count(*)::integer
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1)) AS policies,
       (SELECT count(*)::integer
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND NOT t.tgisinternal) AS user_triggers,
       (SELECT count(*)::integer FROM pg_largeobject_metadata) AS large_objects,
       (SELECT count(*)::integer
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relpersistence = 'u') AS unlogged_relations,
       (SELECT count(*)::integer
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('v', 'm', 'f', 'c')) AS unsupported_relations,
       (SELECT count(*)::integer
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = ANY($1) AND t.typtype IN ('d', 'e')) AS custom_types,
       (SELECT count(*)::integer
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY($1)
          AND NOT EXISTS (
            SELECT 1
            FROM pg_depend d
            WHERE d.classid = 'pg_proc'::regclass
              AND d.objid = p.oid
              AND d.deptype = 'e'
          )) AS custom_functions`,
    [SCHEMAS],
  );
  return result.rows[0];
}

function comparableDatabaseState(state) {
  const normalizeLibcLocale = (value) => value?.toLowerCase().replace('utf-8', 'utf8');
  return {
    server_major: state.server_major,
    encoding: state.encoding,
    locale_provider: state.locale_provider,
    icu_locale: state.icu_locale,
    lc_collate: normalizeLibcLocale(state.lc_collate),
    lc_ctype: normalizeLibcLocale(state.lc_ctype),
    time_zone: state.time_zone,
  };
}

function databaseIsHealthy(state) {
  return (
    state.server_major === 17 &&
    state.encoding === 'UTF8' &&
    state.locale_provider === 'i' &&
    state.icu_locale === 'en-US' &&
    state.time_zone === 'UTC' &&
    state.configured_collation_version === state.actual_collation_version
  );
}

function unsupportedObjectsAreAbsent(state) {
  return Object.values(state).every((count) => count === 0);
}

function vectorVersionsAreCompatible(sourceVersion, targetVersion) {
  const parse = (value) => value?.split('.').map((part) => Number(part));
  const source = parse(sourceVersion);
  const target = parse(targetVersion);
  return Boolean(
    source &&
      target &&
      source.length >= 3 &&
      target.length >= 3 &&
      source[0] === 0 &&
      source[1] === 8 &&
      target[0] === source[0] &&
      target[1] === source[1] &&
      target[2] >= source[2],
  );
}

function comparable(value) {
  return JSON.stringify(value);
}

async function collect(client) {
  const schema = await schemaState(client);
  const tables = {};
  for (const table of schema) {
    tables[`${table.schema_name}.${table.table_name}`] = await tableState(client, table);
  }
  return {
    database: await databaseState(client),
    schema,
    tables,
    requestLogDays: await requestLogDays(client),
    sequences: await sequenceState(client),
    unsupportedObjects: await unsupportedObjectState(client),
    vector: await extensionState(client),
  };
}

const source = new Client(
  secureConnectionConfig(sourceUrl, {
    label: 'Source database',
    allowInsecureTls: false,
    applicationName: 'sophy-db-compare-source',
    ca: sourceCa,
  }),
);
const target = new Client(
  secureConnectionConfig(targetUrl, {
    label: 'Target database',
    allowInsecureTls: false,
    applicationName: 'sophy-db-compare-target',
    expectedHostSuffix: 'postgres.database.azure.com',
    expectedPort: 5432,
  }),
);

let failed = false;
try {
  await Promise.all([source.connect(), target.connect()]);
  await Promise.all([
    source.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'),
    target.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'),
  ]);
  await Promise.all([
    source.query('SET LOCAL statement_timeout = 0'),
    target.query('SET LOCAL statement_timeout = 0'),
  ]);

  const [sourceState, targetState] = await Promise.all([collect(source), collect(target)]);
  const schemaHealth = {
    source:
      sourceState.schema.length === EXPECTED_TABLE_COUNT &&
      sourceState.schema.every((table) => table.indexes_valid && table.constraints_valid),
    target:
      targetState.schema.length === EXPECTED_TABLE_COUNT &&
      targetState.schema.every((table) => table.indexes_valid && table.constraints_valid),
  };
  const databaseHealth = {
    source: databaseIsHealthy(sourceState.database),
    target: databaseIsHealthy(targetState.database),
  };
  const comparisons = {
    database:
      comparable(comparableDatabaseState(sourceState.database)) ===
      comparable(comparableDatabaseState(targetState.database)),
    databaseHealth,
    schema: comparable(sourceState.schema) === comparable(targetState.schema),
    schemaHealth,
    tables: {},
    requestLogDays:
      comparable(sourceState.requestLogDays) === comparable(targetState.requestLogDays),
    sequences: comparable(sourceState.sequences) === comparable(targetState.sequences),
    unsupportedObjects: {
      source: unsupportedObjectsAreAbsent(sourceState.unsupportedObjects),
      target: unsupportedObjectsAreAbsent(targetState.unsupportedObjects),
    },
    vectorInstalledInPublic:
      sourceState.vector?.schema_name === 'public' && targetState.vector?.schema_name === 'public',
    vectorVersionsCompatible: vectorVersionsAreCompatible(
      sourceState.vector?.extversion,
      targetState.vector?.extversion,
    ),
  };

  const tableNames = [...new Set([
    ...Object.keys(sourceState.tables),
    ...Object.keys(targetState.tables),
  ])].sort();
  for (const tableName of tableNames) {
    comparisons.tables[tableName] =
      comparable(sourceState.tables[tableName]) === comparable(targetState.tables[tableName]);
  }

  failed =
    !comparisons.database ||
    !comparisons.databaseHealth.source ||
    !comparisons.databaseHealth.target ||
    !comparisons.schema ||
    !comparisons.schemaHealth.source ||
    !comparisons.schemaHealth.target ||
    !comparisons.requestLogDays ||
    !comparisons.sequences ||
    !comparisons.unsupportedObjects.source ||
    !comparisons.unsupportedObjects.target ||
    !comparisons.vectorInstalledInPublic ||
    !comparisons.vectorVersionsCompatible ||
    Object.values(comparisons.tables).some((equal) => !equal);

  console.log(
    JSON.stringify(
      {
        mode: DEEP ? 'deep' : 'keys-only',
        equal: !failed,
        comparisons,
        vectorVersions: {
          source: sourceState.vector?.extversion ?? null,
          target: targetState.vector?.extversion ?? null,
        },
        collationVersions: {
          source: {
            configured: sourceState.database.configured_collation_version,
            actual: sourceState.database.actual_collation_version,
          },
          target: {
            configured: targetState.database.configured_collation_version,
            actual: targetState.database.actual_collation_version,
          },
        },
        unsupportedObjectCounts: {
          source: sourceState.unsupportedObjects,
          target: targetState.unsupportedObjects,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.allSettled([source.query('ROLLBACK'), target.query('ROLLBACK')]);
  await Promise.allSettled([source.end(), target.end()]);
}

if (failed) process.exitCode = 1;
