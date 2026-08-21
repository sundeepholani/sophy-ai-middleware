const SSL_QUERY_PARAMETERS = [
  'ssl',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslpassword',
  'sslcrl',
  'uselibpqcompat',
];
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
];

export function requiredDatabaseUrl(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}.`);
  return value;
}

function parseDatabaseUrl(connectionString, label) {
  try {
    const url = new URL(connectionString);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new Error('unsupported protocol');
    }
    if (CONNECTION_OVERRIDE_PARAMETERS.some((parameter) => url.searchParams.has(parameter))) {
      throw new Error('connection override');
    }
    return url;
  } catch {
    throw new Error(`${label} is invalid or contains a connection override.`);
  }
}

export function secureConnectionConfig(connectionString, options) {
  const url = parseDatabaseUrl(connectionString, options.label);
  if (options.expectedHostSuffix) {
    const suffix = options.expectedHostSuffix.toLowerCase().replace(/^\.+/, '');
    const host = url.hostname.toLowerCase();
    if (host !== suffix && !host.endsWith(`.${suffix}`)) {
      throw new Error(`${options.label} host does not match the expected provider.`);
    }
  }
  if (options.expectedPort && url.port !== String(options.expectedPort)) {
    throw new Error(`${options.label} must use port ${options.expectedPort}.`);
  }
  const sslMode = (url.searchParams.get('sslmode') ?? 'verify-full').toLowerCase();
  const insecure = sslMode === 'disable' || sslMode === 'no-verify';
  if (insecure && !options.allowInsecureTls) {
    throw new Error(`${options.label} requires sslmode=verify-full.`);
  }
  if (!['disable', 'no-verify', 'require', 'verify-ca', 'verify-full'].includes(sslMode)) {
    throw new Error(`${options.label} has an unsupported sslmode.`);
  }

  for (const parameter of SSL_QUERY_PARAMETERS) url.searchParams.delete(parameter);
  return {
    connectionString: url.toString(),
    application_name: options.applicationName,
    ssl:
      sslMode === 'disable'
        ? undefined
        : {
            rejectUnauthorized: !insecure,
            ...(options.ca ? { ca: options.ca } : {}),
          },
  };
}

export function databaseIdentity(connectionString) {
  const url = parseDatabaseUrl(connectionString, 'Database connection string');
  try {
    const database = decodeURI(url.pathname.replace(/^\/+/, ''));
    return `${url.hostname.toLowerCase()}/${database}`;
  } catch {
    throw new Error('Database connection string contains an invalid database name.');
  }
}
