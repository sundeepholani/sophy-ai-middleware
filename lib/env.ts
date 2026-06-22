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

function requireOneOf(...names: string[]): string {
  for (const n of names) {
    const v = optionalEnv(n);
    if (v) return v;
  }
  throw new Error(
    `Missing required environment variable: one of ${names.join(', ')}. ` +
      `See .env.example for the full list and provisioning notes.`,
  );
}

export const env = {
  // --- Postgres (Supabase via Vercel Marketplace) ---
  // The Vercel↔Supabase integration provisions POSTGRES_URL (pooled / Supavisor
  // transaction mode) and POSTGRES_URL_NON_POOLING (direct). A manual setup uses
  // DATABASE_URL / DATABASE_URL_UNPOOLED. We accept either naming.
  /** Pooled (transaction-mode) connection string used by the running app. */
  databaseUrl: () => requireOneOf('DATABASE_URL', 'POSTGRES_URL'),
  /** Direct/unpooled connection string used only for migrations. */
  databaseUrlUnpooled: () =>
    optionalEnv('DATABASE_URL_UNPOOLED') ??
    optionalEnv('POSTGRES_URL_NON_POOLING') ??
    requireOneOf('DATABASE_URL', 'POSTGRES_URL'),
  /** Set to "1" to skip TLS CA verification (some poolers present an untrusted chain). */
  databaseSslNoVerify: () => optionalEnv('DATABASE_SSL_NO_VERIFY') === '1',

  // --- AI Gateway ---
  /** Optional in prod (OIDC token is used automatically); required locally. */
  aiGatewayApiKey: () => optionalEnv('AI_GATEWAY_API_KEY'),

  // --- Secrets ---
  /** HMAC pepper for hashing client API keys at rest. */
  keyHashPepper: () => requireEnv('KEY_HASH_PEPPER'),
  /** iron-session cookie password (>= 32 chars). */
  sessionPassword: () => requireEnv('SESSION_PASSWORD'),
  /** Email seeded as the first admin on bootstrap (passwordless login thereafter). */
  bootstrapAdminEmail: () => optionalEnv('BOOTSTRAP_ADMIN_EMAIL'),
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
