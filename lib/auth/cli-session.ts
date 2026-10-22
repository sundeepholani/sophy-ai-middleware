/** CLI credentials are accepted only by explicitly scoped management handlers. */
import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { cliSessions, users } from '@/db/schema';
import { hashToken } from '@/lib/auth/magic-link';

export interface CliIdentity {
  userId: string;
  email: string;
  sessionId: string;
  expiresAt: Date;
}

/**
 * Sliding CLI session window: a session expires this long after its LAST
 * authenticated request, not after login. A CLI used at least once per window
 * stays signed in; an idle one lapses. Revocation (logout) and deactivating the
 * user still lock it out immediately.
 */
export const CLI_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Renewal throttle: the stored expiry is pushed out only once it trails the
 * fresh window by more than this, so steady use costs at most one write per
 * session per day. Worst case a session expires this much early, never late.
 */
export const CLI_SESSION_RENEW_AFTER_SECONDS = 60 * 60 * 24; // 1 day

/** The renewed expiry for a session used at `now`, or null when a write isn't due yet. */
export function renewedCliSessionExpiry(currentExpiresAt: Date, now = new Date()): Date | null {
  const next = new Date(now.getTime() + CLI_SESSION_TTL_SECONDS * 1000);
  return next.getTime() - currentExpiresAt.getTime() > CLI_SESSION_RENEW_AFTER_SECONDS * 1000 ? next : null;
}

const identityScope = new AsyncLocalStorage<CliIdentity>();

export function withCliIdentity<T>(identity: CliIdentity, callback: () => Promise<T>): Promise<T> {
  return identityScope.run(identity, callback);
}

export function getScopedCliIdentity(): CliIdentity | undefined {
  return identityScope.getStore();
}

export async function createCliSession(userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = `sophy_cli_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + CLI_SESSION_TTL_SECONDS * 1000);
  await getDb().insert(cliSessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * Authenticate a CLI bearer token. By default a successful lookup also slides
 * the session's expiry (see CLI_SESSION_TTL_SECONDS); logout passes
 * `renew: false` since it is about to revoke the session anyway.
 */
export async function resolveCliSession(
  authorization: string | null,
  { renew = true }: { renew?: boolean } = {},
): Promise<CliIdentity | null> {
  const match = /^Bearer (sophy_cli_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? '');
  if (!match) return null;
  const now = new Date();
  const [identity] = await getDb().select({
    userId: users.id, email: users.email, sessionId: cliSessions.id, expiresAt: cliSessions.expiresAt,
  }).from(cliSessions).innerJoin(users, eq(users.id, cliSessions.userId))
    .where(and(eq(cliSessions.tokenHash, hashToken(match[1])),
      isNull(cliSessions.revokedAt), gt(cliSessions.expiresAt, now), eq(users.status, 'active'))).limit(1);
  if (!identity) return null;
  const renewed = renew ? renewedCliSessionExpiry(identity.expiresAt, now) : null;
  if (!renewed) return identity;
  // Re-check revocation and expiry in the write itself so a concurrent logout
  // (or a session that lapsed since the read) is never revived. The `lt` guard
  // keeps concurrent renewals from moving the expiry backwards.
  const [row] = await getDb().update(cliSessions).set({ expiresAt: renewed })
    .where(and(eq(cliSessions.id, identity.sessionId), isNull(cliSessions.revokedAt),
      gt(cliSessions.expiresAt, now), lt(cliSessions.expiresAt, renewed)))
    .returning({ expiresAt: cliSessions.expiresAt });
  return row ? { ...identity, expiresAt: row.expiresAt } : identity;
}

export async function revokeCliSession(sessionId: string, userId: string): Promise<void> {
  await getDb().update(cliSessions).set({ revokedAt: new Date() })
    .where(and(eq(cliSessions.id, sessionId), eq(cliSessions.userId, userId)));
}
