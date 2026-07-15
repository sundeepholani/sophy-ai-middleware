/**
 * Passwordless identity auth.
 *
 * Existing identities receive login_tokens. Unknown emails receive auth_intents;
 * only verified redemption creates the identity plus its admin-owned “My
 * Project”. Project invitations use their own explicit acceptance flow.
 */
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  auditLog,
  authIntents,
  loginTokens,
  projectMemberships,
  projectSettings,
  projects,
  users,
  type UserStatus,
} from '@/db/schema';

const TOKEN_TTL_MS = 15 * 60_000;

export interface AuthUser {
  id: string;
  email: string;
}

export type AuthTokenPurpose = 'login' | 'signup';

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

/** Pure onboarding decision shared by implementation and focused tests. */
export function authIntentOnboardingDecision(
  existingStatus: UserStatus | null,
): 'create_my_project' | 'sign_in' | 'reject' {
  if (existingStatus === null) return 'create_my_project';
  return existingStatus === 'active' ? 'sign_in' : 'reject';
}

/** An active user for the given email, or null (unknown or inactive). */
export async function findActiveUserByEmail(email: string): Promise<AuthUser | null> {
  const [row] = await getDb()
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  if (!row || row.status !== 'active') return null;
  return { id: row.id, email: row.email };
}

/** Mint a single-use token for an existing identity. */
export async function createLoginToken(userId: string, email: string): Promise<string> {
  const db = getDb();
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

/** Mint a verified-signup intent without pre-creating an identity or project. */
export async function createSignupIntent(email: string): Promise<string> {
  const normalized = normalizeEmail(email);
  const db = getDb();
  await db
    .update(authIntents)
    .set({ consumedAt: new Date() })
    .where(and(eq(authIntents.email, normalized), isNull(authIntents.consumedAt)));
  const raw = randomBytes(32).toString('base64url');
  await db.insert(authIntents).values({
    email: normalized,
    purpose: 'signup',
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });
  return raw;
}

export async function createAuthenticationToken(email: string): Promise<{
  raw: string;
  purpose: AuthTokenPurpose;
}> {
  const normalized = normalizeEmail(email);
  const existing = await findActiveUserByEmail(normalized);
  if (existing) {
    return {
      raw: await createLoginToken(existing.id, existing.email),
      purpose: 'login',
    };
  }
  return { raw: await createSignupIntent(normalized), purpose: 'signup' };
}

async function consumeExistingLogin(tokenHash: string): Promise<AuthUser | null> {
  return getDb().transaction(async (tx) => {
    const [token] = await tx
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
    if (!token || !constantTimeEqualHex(tokenHash, token.storedHash)) return null;

    const [identity] = await tx
      .select({ id: users.id, email: users.email, status: users.status })
      .from(users)
      .where(eq(users.id, token.userId))
      .limit(1);
    if (!identity || identity.status !== 'active') return null;
    await tx
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, identity.id));
    return { id: identity.id, email: identity.email };
  });
}

async function consumeSignupIntent(tokenHash: string): Promise<AuthUser | null> {
  return getDb().transaction(async (tx) => {
    const [intent] = await tx
      .update(authIntents)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authIntents.tokenHash, tokenHash),
          isNull(authIntents.consumedAt),
          gt(authIntents.expiresAt, new Date()),
        ),
      )
      .returning({ email: authIntents.email, storedHash: authIntents.tokenHash });
    if (!intent || !constantTimeEqualHex(tokenHash, intent.storedHash)) return null;

    const [existing] = await tx
      .select({ id: users.id, email: users.email, status: users.status })
      .from(users)
      .where(eq(users.email, intent.email))
      .limit(1);
    const decision = authIntentOnboardingDecision(existing?.status ?? null);
    if (decision === 'reject') return null;
    if (decision === 'sign_in' && existing) {
      await tx
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, existing.id));
      return { id: existing.id, email: existing.email };
    }

    const userId = randomUUID();
    const projectId = randomUUID();
    const now = new Date();
    const [created] = await tx
      .insert(users)
      .values({
        id: userId,
        email: intent.email,
        // Compatibility column only; projectMemberships.role is authoritative.
        role: 'editor',
        status: 'active',
        lastLoginAt: now,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, email: users.email });

    // Two valid intents for the same email can race. Only the transaction that
    // inserted the identity creates My Project; the other signs into that same
    // identity after the unique constraint resolves.
    if (!created) {
      const [winner] = await tx
        .select({ id: users.id, email: users.email, status: users.status })
        .from(users)
        .where(eq(users.email, intent.email))
        .limit(1);
      if (!winner || winner.status !== 'active') return null;
      await tx
        .update(users)
        .set({ lastLoginAt: now })
        .where(eq(users.id, winner.id));
      return { id: winner.id, email: winner.email };
    }

    await tx.insert(projects).values({
      id: projectId,
      name: 'My Project',
      slug: `my-project-${projectId.slice(0, 8)}`,
      createdByUserId: userId,
      status: 'active',
    });
    await tx.insert(projectMemberships).values({
      projectId,
      userId,
      role: 'admin',
      status: 'active',
    });
    await tx.insert(projectSettings).values({ projectId });
    await tx
      .update(users)
      .set({ defaultProjectId: projectId, onboardedAt: now })
      .where(eq(users.id, userId));
    await tx.insert(auditLog).values({
      projectId,
      actor: intent.email,
      action: 'project.create',
      target: projectId,
      after: { name: 'My Project', source: 'self_signup' },
    });
    return created;
  });
}

/**
 * Redeem either token family. A signup token only creates My Project when no
 * identity exists; an identity first created through invitation acceptance is
 * simply signed in and keeps its invitation project as default.
 */
export async function consumeToken(raw: string): Promise<AuthUser | null> {
  if (!raw) return null;
  const tokenHash = hashToken(raw);
  return (await consumeExistingLogin(tokenHash)) ?? consumeSignupIntent(tokenHash);
}

/** Absolute verify URL for the emailed link, built from the trusted origin. */
export function buildVerifyUrl(origin: string, raw: string, next?: string | null): string {
  const url = new URL('/admin/auth/verify', origin);
  url.searchParams.set('token', raw);
  if (next) url.searchParams.set('next', next);
  return url.toString();
}
