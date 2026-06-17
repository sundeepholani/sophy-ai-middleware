/**
 * Upstash Redis — the hot-path store for rate limits, period-keyed quota
 * counters, the instant key-revocation flag, admin login throttling, and the
 * cron distributed lock. Postgres remains the durable source of truth.
 */
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { env } from '@/lib/env';

let _redis: Redis | undefined;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: env.upstashRedisRestUrl(),
      token: env.upstashRedisRestToken(),
    });
  }
  return _redis;
}

// ---- Rate limiting (sliding window, per-key dynamic rpm) -------------------

const limiters = new Map<number, Ratelimit>();

function getLimiter(rpm: number): Ratelimit {
  let limiter = limiters.get(rpm);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(rpm, '1 m'),
      prefix: 'rl',
    });
    limiters.set(rpm, limiter);
  }
  return limiter;
}

export interface RateLimitResult {
  ok: boolean;
  remaining?: number;
  /** Unix ms when the window resets. */
  reset?: number;
}

export async function checkRateLimit(
  keyId: string,
  rpm: number | null | undefined,
): Promise<RateLimitResult> {
  if (!rpm || rpm <= 0) return { ok: true };
  const { success, remaining, reset } = await getLimiter(rpm).limit(keyId);
  return { ok: success, remaining, reset };
}

// ---- Period-keyed quota counters -------------------------------------------

/** Current monthly period key, e.g. "202606". */
export function currentPeriod(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

const QUOTA_TTL_SECONDS = 70 * 24 * 60 * 60; // ~70 days; old periods self-expire.

function quotaKey(keyId: string, period = currentPeriod()): string {
  return `quota:${keyId}:${period}`;
}

/** Tokens consumed by this key in the current period (pre-check). */
export async function quotaUsed(keyId: string): Promise<number> {
  const v = await getRedis().get<number>(quotaKey(keyId));
  return typeof v === 'number' ? v : Number(v) || 0;
}

/** Atomically charge tokens to this key's current-period counter (post-charge). */
export async function quotaCharge(keyId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const key = quotaKey(keyId);
  const total = await getRedis().incrby(key, tokens);
  if (total === tokens) {
    // First write of the period — set an expiry so stale periods self-clean.
    await getRedis().expire(key, QUOTA_TTL_SECONDS);
  }
}

// ---- Instant key revocation ------------------------------------------------

export async function isRevoked(keyId: string): Promise<boolean> {
  return (await getRedis().get(`revoked:${keyId}`)) != null;
}

export async function markRevoked(keyId: string): Promise<void> {
  await getRedis().set(`revoked:${keyId}`, '1');
}

export async function unmarkRevoked(keyId: string): Promise<void> {
  await getRedis().del(`revoked:${keyId}`);
}

// ---- Admin login throttling ------------------------------------------------

let _loginLimiter: Ratelimit | undefined;

export async function checkLoginRateLimit(identifier: string): Promise<boolean> {
  if (!_loginLimiter) {
    _loginLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(10, '15 m'),
      prefix: 'login',
    });
  }
  const { success } = await _loginLimiter.limit(identifier);
  return success;
}

// ---- Cron distributed lock -------------------------------------------------

export async function acquireLock(name: string, ttlSeconds: number): Promise<boolean> {
  const res = await getRedis().set(`lock:${name}`, '1', { nx: true, ex: ttlSeconds });
  return res === 'OK';
}

export async function releaseLock(name: string): Promise<void> {
  await getRedis().del(`lock:${name}`);
}
