/**
 * Client API key issuance and verification.
 *
 * Keys look like `mw_<env>_<48 hex chars>`. We store:
 *   - key_prefix  `mw_<env>_<first 8 hex>`  (non-secret, unique, indexed lookup)
 *   - key_hash    HMAC-SHA256(full_key, KEY_HASH_PEPPER), hex   (fast verify)
 *   - key_last4   last 4 hex                                     (display only)
 *
 * HMAC (not bcrypt) is correct here: keys are high-entropy and verified on every
 * request, so we want a fast keyed MAC + a server-side pepper, not a slow KDF.
 * The raw key is shown once at creation and never retrievable.
 */
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { apiKeys, type KeyScopes, type KeyStatus } from '@/db/schema';
import { env } from '@/lib/env';
import { isRevoked } from '@/lib/redis';

export interface GeneratedKey {
  fullKey: string;
  prefix: string;
  last4: string;
  hash: string;
}

export interface VerifiedKey {
  id: string;
  clientId: string;
  name: string;
  scopes: KeyScopes;
  status: KeyStatus;
}

function hmac(fullKey: string): string {
  return createHmac('sha256', env.keyHashPepper()).update(fullKey).digest('hex');
}

/** Derive the lookup prefix from a presented full key, or null if malformed. */
export function keyPrefixOf(fullKey: string): string | null {
  const parts = fullKey.split('_');
  if (parts.length !== 3 || parts[0] !== 'mw') return null;
  const [, keyEnv, random] = parts;
  if (!/^[0-9a-f]{48}$/.test(random)) return null;
  return `mw_${keyEnv}_${random.slice(0, 8)}`;
}

/** Generate a fresh key (not yet persisted). */
export function generateKey(): GeneratedKey {
  const random = randomBytes(24).toString('hex'); // 48 hex chars, 192 bits
  const fullKey = `mw_${env.keyEnv()}_${random}`;
  return {
    fullKey,
    prefix: `mw_${env.keyEnv()}_${random.slice(0, 8)}`,
    last4: random.slice(-4),
    hash: hmac(fullKey),
  };
}

/** Issue and persist a new key for a client. Returns the raw key (show once). */
export async function issueKey(input: {
  clientId: string;
  name: string;
  scopes?: KeyScopes;
}): Promise<{ fullKey: string; id: string; prefix: string; last4: string }> {
  const gen = generateKey();
  const [row] = await getDb()
    .insert(apiKeys)
    .values({
      clientId: input.clientId,
      name: input.name,
      keyPrefix: gen.prefix,
      keyHash: gen.hash,
      keyLast4: gen.last4,
      scopes: input.scopes ?? {},
    })
    .returning({ id: apiKeys.id });
  return { fullKey: gen.fullKey, id: row.id, prefix: gen.prefix, last4: gen.last4 };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify a presented bearer token. Returns the key record on success, or null
 * for any failure (malformed, unknown, bad hash, expired, revoked).
 *
 * Revocation is checked against Redis for strong consistency — a revoked key is
 * rejected immediately, regardless of any cached/DB lag.
 */
export async function verifyKey(presented: string): Promise<VerifiedKey | null> {
  const prefix = keyPrefixOf(presented);
  if (!prefix) return null;

  const [row] = await getDb()
    .select({
      id: apiKeys.id,
      clientId: apiKeys.clientId,
      name: apiKeys.name,
      keyHash: apiKeys.keyHash,
      scopes: apiKeys.scopes,
      status: apiKeys.status,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyPrefix, prefix))
    .limit(1);

  if (!row) return null;
  if (!constantTimeEqualHex(hmac(presented), row.keyHash)) return null;
  if (row.status !== 'active') return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  if (await isRevoked(row.id)) return null;

  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    scopes: row.scopes,
    status: row.status,
  };
}

/** Extract a bearer token from an Authorization header. */
export function bearerFromHeader(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}
