import type { PoolConfig } from 'pg';

const SSL_QUERY_PARAMETERS = [
  'ssl',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslpassword',
  'sslcrl',
  'uselibpqcompat',
] as const;
const CONNECTION_OVERRIDE_PARAMETERS = [
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
] as const;
const AZURE_POSTGRES_HOST_SUFFIX = 'postgres.database.azure.com';

export interface DatabasePoolConfigInput {
  connectionString: string;
  max: number;
  isProduction: boolean;
  allowInsecureTls: boolean;
  expectedHostSuffix?: string;
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedSuffix = suffix.toLowerCase().replace(/^\.+/, '');
  return (
    normalizedSuffix.length > 0 &&
    (normalizedHost === normalizedSuffix || normalizedHost.endsWith(`.${normalizedSuffix}`))
  );
}

function parseDatabaseUrl(connectionString: string): URL {
  try {
    const url = new URL(connectionString);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new Error('unsupported protocol');
    }
    const override = CONNECTION_OVERRIDE_PARAMETERS.find((parameter) =>
      url.searchParams.has(parameter),
    );
    if (override) {
      throw new Error('connection override');
    }
    return url;
  } catch {
    throw new Error('DATABASE_URL is invalid or contains a connection override.');
  }
}

/**
 * Build the node-postgres pool configuration without letting URL TLS options
 * override the explicit certificate policy.
 */
export function buildDatabasePoolConfig(input: DatabasePoolConfigInput): PoolConfig {
  const url = parseDatabaseUrl(input.connectionString);
  if (
    input.isProduction &&
    input.expectedHostSuffix &&
    input.expectedHostSuffix.toLowerCase().replace(/^\.+/, '') !==
      AZURE_POSTGRES_HOST_SUFFIX
  ) {
    throw new Error('Production DATABASE_EXPECTED_HOST_SUFFIX must identify Azure PostgreSQL.');
  }
  const expectedHostSuffix = input.isProduction
    ? AZURE_POSTGRES_HOST_SUFFIX
    : input.expectedHostSuffix;
  if (
    expectedHostSuffix &&
    !hostMatchesSuffix(url.hostname, expectedHostSuffix)
  ) {
    throw new Error('Database host does not match DATABASE_EXPECTED_HOST_SUFFIX.');
  }
  if (input.isProduction && url.port !== '6432') {
    throw new Error('Production DATABASE_URL must use Azure PgBouncer on port 6432.');
  }

  const sslMode = (url.searchParams.get('sslmode') ?? 'verify-full').toLowerCase();
  if (!['disable', 'no-verify', 'require', 'verify-ca', 'verify-full'].includes(sslMode)) {
    throw new Error(`Unsupported database sslmode: ${sslMode}.`);
  }

  const insecureTls = input.allowInsecureTls || sslMode === 'no-verify';
  const tlsDisabled = sslMode === 'disable';
  if (input.isProduction && (insecureTls || tlsDisabled)) {
    throw new Error(
      'Production database connections require verified TLS. Use sslmode=verify-full and unset DATABASE_SSL_NO_VERIFY.',
    );
  }

  // pg-connection-string lets SSL query parameters replace a separate `ssl`
  // object. Remove those parameters before node-postgres parses the URL.
  for (const parameter of SSL_QUERY_PARAMETERS) {
    url.searchParams.delete(parameter);
  }

  return {
    connectionString: url.toString(),
    max: input.max,
    ssl: tlsDisabled
      ? undefined
      : {
          rejectUnauthorized: !insecureTls,
        },
  };
}
