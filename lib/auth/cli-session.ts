/** CLI credentials are accepted only by explicitly scoped management handlers. */
import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { cliSessions, users } from '@/db/schema';
import { hashToken } from '@/lib/auth/magic-link';
import { SESSION_TTL_SECONDS } from '@/lib/auth/session-config';

export interface CliIdentity {
  userId: string;
  email: string;
  sessionId: string;
  expiresAt: Date;
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
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await getDb().insert(cliSessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function resolveCliSession(authorization: string | null): Promise<CliIdentity | null> {
  const match = /^Bearer (sophy_cli_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? '');
  if (!match) return null;
  const [identity] = await getDb().select({
    userId: users.id, email: users.email, sessionId: cliSessions.id, expiresAt: cliSessions.expiresAt,
  }).from(cliSessions).innerJoin(users, eq(users.id, cliSessions.userId))
    .where(and(eq(cliSessions.tokenHash, hashToken(match[1])),
      isNull(cliSessions.revokedAt), gt(cliSessions.expiresAt, new Date()), eq(users.status, 'active'))).limit(1);
  return identity ?? null;
}

export async function revokeCliSession(sessionId: string, userId: string): Promise<void> {
  await getDb().update(cliSessions).set({ revokedAt: new Date() })
    .where(and(eq(cliSessions.id, sessionId), eq(cliSessions.userId, userId)));
}
