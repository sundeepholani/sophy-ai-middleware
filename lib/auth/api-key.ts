/**
 * Client API key issuance and verification.
 *
 * In the simplified model the key IS the configuration: each key carries its
 * model, system prompt, params, optional output schema, and quota. verifyKey()
 * returns all of it, read fresh from Postgres on every request — so admin edits
 * apply instantly and revocation (status) is authoritative with no cache.
 *
 * Keys look like `mw_<env>_<48 hex>`. We store key_prefix (indexed lookup),
 * key_hash = HMAC-SHA256(full_key, KEY_HASH_PEPPER), and key_last4 (display).
 * HMAC (not bcrypt) is correct: keys are high-entropy and verified every request.
 */
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { apiKeys, type KeyParams, type KeyStatus } from '@/db/schema';
import { env } from '@/lib/env';

export interface GeneratedKey {
  fullKey: string;
  prefix: string;
  last4: string;
  hash: string;
}

export interface KeyConfigInput {
  name: string;
  model: string;
  systemPrompt?: string | null;
  params?: KeyParams;
  outputSchema?: Record<string, unknown> | null;
  monthlyTokenCap?: number | null;
  rpmLimit?: number | null;
}

export interface VerifiedKey {
  id: string;
  name: string;
  model: string;
  systemPrompt: string | null;
  params: KeyParams;
  outputSchema: Record<string, unknown> | null;
  monthlyTokenCap: number | null;
  rpmLimit: number | null;
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

/** Issue and persist a new key with its config. Returns the raw key (show once). */
export async function issueKey(
  input: KeyConfigInput,
): Promise<{ fullKey: string; id: string; prefix: string; last4: string }> {
  const gen = generateKey();
  const [row] = await getDb()
    .insert(apiKeys)
    .values({
      name: input.name,
      keyPrefix: gen.prefix,
      keyHash: gen.hash,
      keyLast4: gen.last4,
      model: input.model,
      systemPrompt: input.systemPrompt ?? null,
      params: input.params ?? {},
      outputSchema: input.outputSchema ?? null,
      monthlyTokenCap: input.monthlyTokenCap ?? null,
      rpmLimit: input.rpmLimit ?? null,
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
 * Verify a presented bearer token and return the key + its config, or null for
 * any failure (malformed, unknown, bad hash, expired, revoked). `status` is read
 * fresh from Postgres, so revocation is instant and authoritative.
 */
export async function verifyKey(presented: string): Promise<VerifiedKey | null> {
  const prefix = keyPrefixOf(presented);
  if (!prefix) return null;

  const [row] = await getDb()
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyPrefix, prefix))
    .limit(1);

  if (!row) return null;
  if (!constantTimeEqualHex(hmac(presented), row.keyHash)) return null;
  if (row.status !== 'active') return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  return {
    id: row.id,
    name: row.name,
    model: row.model,
    systemPrompt: row.systemPrompt,
    params: row.params,
    outputSchema: row.outputSchema ?? null,
    monthlyTokenCap: row.monthlyTokenCap,
    rpmLimit: row.rpmLimit,
    status: row.status,
  };
}

/** Extract a bearer token from an Authorization header. */
export function bearerFromHeader(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}
