import { defineConfig } from 'drizzle-kit';

// Migrations use Azure's direct port (5432), never PgBouncer (6432).
const url = process.env.DATABASE_URL_UNPOOLED ?? '';
let parsedUrl: URL | undefined;
const azureHostSuffix = 'postgres.database.azure.com';

if (url) {
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
      throw new Error('unsupported protocol');
    }
    for (const parameter of [
      'host',
      'hostaddr',
      'port',
      'database',
      'dbname',
      'user',
      'password',
      'service',
      'servicefile',
      'options',
      'replication',
    ]) {
      if (parsedUrl.searchParams.has(parameter)) throw new Error('connection override');
    }
  } catch {
    throw new Error('DATABASE_URL_UNPOOLED is invalid or contains a connection override.');
  }
}

if (parsedUrl) {
  const host = parsedUrl.hostname.toLowerCase();
  const configuredSuffix = process.env.DATABASE_EXPECTED_HOST_SUFFIX
    ?.toLowerCase()
    .replace(/^\.+/, '');
  if (
    process.env.NODE_ENV === 'production' &&
    configuredSuffix &&
    configuredSuffix !== azureHostSuffix
  ) {
    throw new Error('Production DATABASE_EXPECTED_HOST_SUFFIX must identify Azure PostgreSQL.');
  }
  const suffix = azureHostSuffix;
  if (host !== suffix && !host.endsWith(`.${suffix}`)) {
    throw new Error('Database host does not match DATABASE_EXPECTED_HOST_SUFFIX.');
  }
  if (parsedUrl.port !== '5432') {
    throw new Error('DATABASE_URL_UNPOOLED must use the direct PostgreSQL port 5432.');
  }
  const sslModes = parsedUrl.searchParams.getAll('sslmode');
  if (sslModes.length !== 1 || sslModes[0]?.toLowerCase() !== 'verify-full') {
    throw new Error('Azure migration connections require sslmode=verify-full.');
  }
  for (const parameter of [
    'ssl',
    'sslcert',
    'sslkey',
    'sslrootcert',
    'sslpassword',
    'sslcrl',
    'uselibpqcompat',
  ]) {
    if (parsedUrl.searchParams.has(parameter)) {
      throw new Error(`Azure migration URL must not contain ${parameter}.`);
    }
  }
}

export default defineConfig({
  schema: './db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: parsedUrl?.toString() ?? url },
  strict: true,
  verbose: true,
});
