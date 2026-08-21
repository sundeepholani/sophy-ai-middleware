/**
 * Centralized, lazily-evaluated environment access.
 *
 * Values are read at call time (never at import) so that `next build` and unit
 * tests do not fail when an unrelated secret is absent. Required values throw a
 * clear error the first time they are actually needed at runtime.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `See .env.example for the full list and provisioning notes.`,
    );
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function positiveIntegerEnv(name: string, fallback: number, maximum: number): number {
  const value = optionalEnv(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
  }
  return parsed;
}

export const env = {
  // --- Azure Database for PostgreSQL ---
  /** Pooled Azure PgBouncer connection string used by the running app. */
  databaseUrl: () => requireEnv('DATABASE_URL'),
  /** Maximum connections per Vercel function instance. */
  databasePoolMax: () => positiveIntegerEnv('DATABASE_POOL_MAX', 5, 20),
  /** Optional runtime guard against a connection to the old database provider. */
  databaseExpectedHostSuffix: () => optionalEnv('DATABASE_EXPECTED_HOST_SUFFIX'),
  /** Local diagnostic escape hatch. Production rejects this setting. */
  databaseSslNoVerify: () => optionalEnv('DATABASE_SSL_NO_VERIFY') === '1',

  // --- AI Gateway ---
  /**
   * Legacy platform credential. It is only valid for the migration-only
   * legacy project's `platform_env` credential row; project-scoped calls
   * must never fall back to it (or to Vercel OIDC) implicitly.
   */
  aiGatewayApiKey: () => optionalEnv('AI_GATEWAY_API_KEY'),
  /** AES-256-GCM key used to encrypt project gateway credentials at rest. */
  projectGatewayEncryptionKey: () => requireEnv('PROJECT_GATEWAY_ENCRYPTION_KEY'),
  /** Version persisted with each ciphertext so a future rotation is explicit. */
  projectGatewayEncryptionKeyVersion: () =>
    optionalEnv('PROJECT_GATEWAY_ENCRYPTION_KEY_VERSION') ?? 'v1',
  /** Independent 32+ byte HMAC key used for non-reversible secret fingerprints. */
  projectGatewayFingerprintKey: () => requireEnv('PROJECT_GATEWAY_FINGERPRINT_KEY'),

  // --- Secrets ---
  /** HMAC pepper for hashing client API keys at rest. */
  keyHashPepper: () => requireEnv('KEY_HASH_PEPPER'),
  /** iron-session cookie password (>= 32 chars). */
  sessionPassword: () => requireEnv('SESSION_PASSWORD'),
  /**
   * Canonical origin (e.g. https://sophy.in) used to build magic-link URLs.
   * MUST be server-controlled — never derived from request Host headers, which
   * are attacker-spoofable and would let a poisoned link leak a valid token.
   * Falls back to Vercel's production URL; undefined locally (dev uses the request origin).
   */
  appOrigin: () => {
    const explicit = optionalEnv('APP_ORIGIN');
    if (explicit) return explicit.replace(/\/+$/, '');
    const vercel = optionalEnv('VERCEL_PROJECT_PRODUCTION_URL');
    return vercel ? `https://${vercel}` : undefined;
  },
  /** Shared secret guarding cron endpoints. */
  cronSecret: () => requireEnv('CRON_SECRET'),

  // --- Vercel Blob ---
  blobReadWriteToken: () => requireEnv('BLOB_READ_WRITE_TOKEN'),

  // --- Misc ---
  /** "live" | "test" — used as the API key prefix segment. */
  keyEnv: () => optionalEnv('MIDDLEWARE_KEY_ENV') ?? 'live',
  nodeEnv: () => process.env.NODE_ENV ?? 'development',
  isProd: () => process.env.NODE_ENV === 'production',
};
