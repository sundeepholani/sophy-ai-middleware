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
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { apiKeys, projects, type KeyParams, type KeyStatus } from '@/db/schema';
import { env } from '@/lib/env';

type Db = ReturnType<typeof getDb>;
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface GeneratedKey {
  fullKey: string;
  prefix: string;
  last4: string;
  hash: string;
}

export interface KeyConfigInput {
  projectId: string;
  name: string;
  model: string;
  systemPrompt?: string | null;
  params?: KeyParams;
  outputSchema?: Record<string, unknown> | null;
  monthlyCostCapUsd?: number | null;
  rpmLimit?: number | null;
  logContent?: boolean;
  /** Owning operator (admin or editor); null = unassigned. Set by the caller. */
  ownerUserId?: string | null;
  /** Attached knowledgebase for RAG grounding; null = none. */
  knowledgebaseId?: string | null;
}

export interface VerifiedKey {
  id: string;
  projectId: string;
  name: string;
  model: string;
  systemPrompt: string | null;
  params: KeyParams;
  outputSchema: Record<string, unknown> | null;
  monthlyCostCapUsd: number | null;
  rpmLimit: number | null;
  logContent: boolean;
  status: KeyStatus;
  /** Attached knowledgebase id, or null. Drives query-time RAG retrieval. */
  knowledgebaseId: string | null;
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
  db: Db | DbTx = getDb(),
): Promise<{ fullKey: string; id: string; prefix: string; last4: string }> {
  const gen = generateKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      projectId: input.projectId,
      name: input.name,
      keyPrefix: gen.prefix,
      keyHash: gen.hash,
      keyLast4: gen.last4,
      model: input.model,
      systemPrompt: input.systemPrompt ?? null,
      params: input.params ?? {},
      outputSchema: input.outputSchema ?? null,
      monthlyCostCapUsd: input.monthlyCostCapUsd ?? null,
      rpmLimit: input.rpmLimit ?? null,
      logContent: input.logContent ?? true,
      ownerUserId: input.ownerUserId ?? null,
      knowledgebaseId: input.knowledgebaseId ?? null,
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
    .select({
      key: apiKeys,
      projectStatus: projects.status,
    })
    .from(apiKeys)
    .innerJoin(
      projects,
      and(eq(projects.id, apiKeys.projectId), eq(projects.status, 'active')),
    )
    .where(eq(apiKeys.keyPrefix, prefix))
    .limit(1);

  if (!row) return null;
  const key = row.key;
  if (row.projectStatus !== 'active') return null;
  if (!constantTimeEqualHex(hmac(presented), key.keyHash)) return null;
  if (key.status !== 'active') return null;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;

  return {
    id: key.id,
    projectId: key.projectId,
    name: key.name,
    model: key.model,
    systemPrompt: key.systemPrompt,
    params: key.params,
    outputSchema: key.outputSchema ?? null,
    monthlyCostCapUsd: key.monthlyCostCapUsd,
    rpmLimit: key.rpmLimit,
    logContent: key.logContent,
    status: key.status,
    knowledgebaseId: key.knowledgebaseId,
  };
}

/** Extract a bearer token from an Authorization header. */
export function bearerFromHeader(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}
