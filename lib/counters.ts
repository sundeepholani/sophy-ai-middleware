/**
 * Hot-path counters on PostgreSQL. This layer replaces the previous Upstash
 * Redis layer and keeps quota state in the application database.
 *
 * - Rate limiting: atomic fixed-window counter (`rate_counters`), one statement.
 * - Quota: derived from the sum of cost_usd in `usage_events` for the current UTC
 *   month — the usage_event insert IS the charge, so there's no separate counter.
 * - Revocation: NOT here — key `status` is read fresh from Postgres on every
 *   request in verifyKey(), so revocation is already instant and authoritative.
 * - Cron lock: a row in `locks` with an expiry (pooling-safe, unlike session
 *   advisory locks under the transaction pooler).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

type Rows = { rows: Array<Record<string, unknown>> };

// ---- Rate limiting (fixed window) ------------------------------------------

export interface RateLimitResult {
  ok: boolean;
  /** Unix ms when the current window resets. */
  reset?: number;
}

async function bumpWindow(
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const win = Math.floor(Date.now() / windowMs);
  const res = (await getDb().execute(sql`
    INSERT INTO rate_counters (bucket, window_start, count)
    VALUES (${bucket}, ${win}, 1)
    ON CONFLICT (bucket) DO UPDATE SET
      count = CASE WHEN rate_counters.window_start = ${win} THEN rate_counters.count + 1 ELSE 1 END,
      window_start = ${win}
    RETURNING count
  `)) as unknown as Rows;
  const count = Number(res.rows?.[0]?.count ?? 1);
  return { ok: count <= limit, reset: (win + 1) * windowMs };
}

export async function checkRateLimit(
  keyId: string,
  rpm: number | null | undefined,
): Promise<RateLimitResult> {
  if (!rpm || rpm <= 0) return { ok: true };
  return bumpWindow(`rl:${keyId}`, rpm, 60_000);
}

export async function checkLoginRateLimit(identifier: string): Promise<boolean> {
  const { ok } = await bumpWindow(`login:${identifier}`, 10, 15 * 60_000);
  return ok;
}

// ---- Quota (period = current UTC calendar month) ---------------------------

function startOfUtcMonth(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * USD spend by this key so far this UTC month (summed from recorded gateway
 * costs). Both the primary proxy row and an optional transcript-processor
 * component are client spend. Eval challenger/judge and KB rows carry the key's
 * id for attribution but are Sophy-initiated spend — charging them here would
 * let an operator-started eval push a client key over its cap.
 */
export async function costUsedThisMonth(keyId: string): Promise<number> {
  const since = startOfUtcMonth();
  const res = (await getDb().execute(sql`
    SELECT coalesce(sum(cost_usd), 0)::numeric AS used
    FROM usage_events
    WHERE api_key_id = ${keyId}
      AND created_at >= ${since}
      AND source IN ('proxy', 'transcript_processor')
  `)) as unknown as Rows;
  return Number(res.rows?.[0]?.used ?? 0);
}

// ---- Cron lock (row with expiry; transaction-pooler safe) ------------------

export async function acquireLock(name: string, ttlSeconds: number): Promise<boolean> {
  const expires = new Date(Date.now() + ttlSeconds * 1000);
  const res = (await getDb().execute(sql`
    INSERT INTO locks (name, expires_at) VALUES (${name}, ${expires})
    ON CONFLICT (name) DO UPDATE SET expires_at = ${expires}
    WHERE locks.expires_at < now()
    RETURNING name
  `)) as unknown as Rows;
  return (res.rows?.length ?? 0) > 0;
}

export async function releaseLock(name: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM locks WHERE name = ${name}`);
}
