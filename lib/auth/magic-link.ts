/**
 * Passwordless magic-link auth: mint, email, and redeem one-time login tokens.
 *
 * Tokens are 32 random bytes; only their SHA-256 hash is stored (the raw token
 * lives solely in the emailed link). Redemption is single-use (atomic flip of
 * consumed_at) and short-lived (15 min), with a constant-time hash compare.
 * Mirrors the hashing discipline of lib/auth/api-key.ts.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { users, loginTokens, type UserRole } from '@/db/schema';

const TOKEN_TTL_MS = 15 * 60_000;

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

/** Canonical email form used for storage and lookup. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** An active user for the given email, or null (unknown or inactive). */
export async function findActiveUserByEmail(email: string): Promise<AuthUser | null> {
  const [row] = await getDb()
    .select({ id: users.id, email: users.email, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  if (!row || row.status !== 'active') return null;
  return { id: row.id, email: row.email, role: row.role };
}

/** Mint a single-use magic-link token, invalidating the user's prior unconsumed ones. */
export async function createLoginToken(userId: string, email: string): Promise<string> {
  const db = getDb();
  // Only the newest link should work — burn any outstanding ones.
  await db
    .update(loginTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(loginTokens.userId, userId), isNull(loginTokens.consumedAt)));
  const raw = randomBytes(32).toString('base64url');
  await db.insert(loginTokens).values({
    userId,
    email: normalizeEmail(email),
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });
  return raw;
}

/**
 * Atomically redeem a token and return the (active) user, or null if the token is
 * unknown / expired / already consumed, or the user is inactive. Sets lastLoginAt.
 */
export async function consumeToken(raw: string): Promise<AuthUser | null> {
  if (!raw) return null;
  const db = getDb();
  const tokenHash = hashToken(raw);
  // Single-use: only one caller can flip consumed_at from null, and only before expiry.
  const [tok] = await db
    .update(loginTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(loginTokens.tokenHash, tokenHash),
        isNull(loginTokens.consumedAt),
        gt(loginTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: loginTokens.userId, storedHash: loginTokens.tokenHash });
  if (!tok) return null;
  // Defense-in-depth constant-time compare (the WHERE already matched the indexed hash).
  if (!constantTimeEqualHex(tokenHash, tok.storedHash)) return null;

  const [u] = await db
    .select({ id: users.id, email: users.email, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, tok.userId))
    .limit(1);
  if (!u || u.status !== 'active') return null;

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
  return { id: u.id, email: u.email, role: u.role };
}

/** Absolute verify URL for the emailed link, built from the request origin. */
export function buildVerifyUrl(origin: string, raw: string, next?: string | null): string {
  const u = new URL('/admin/auth/verify', origin);
  u.searchParams.set('token', raw);
  if (next) u.searchParams.set('next', next);
  return u.toString();
}
