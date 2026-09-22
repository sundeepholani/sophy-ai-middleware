/** Email OTPs: durable throttling, keyed hashes, and serialized single-use redemption. */
import 'server-only';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  auditLog, loginChallenges, projectInvitations, projectMemberships,
  projectSettings, projects, users,
} from '@/db/schema';
import { env } from '@/lib/env';
import { hashToken, normalizeEmail, type AuthUser } from '@/lib/auth/magic-link';
import { safeNextPath } from '@/lib/auth/safe-next';

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

export function hashOtp(challengeId: string, email: string, code: string): string {
  return createHmac('sha256', env.sessionPassword())
    .update(JSON.stringify(['sophy:email-otp:v1', challengeId, normalizeEmail(email), code]))
    .digest('hex');
}

function matchesOtp(storedHash: string, candidateHash: string): boolean {
  const stored = Buffer.from(storedHash, 'hex');
  const candidate = Buffer.from(candidateHash, 'hex');
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

/** Only the explicit invitation landing carries invitation-first signup context. */
export function invitationTokenFromNext(next?: string | null): string | null {
  const url = new URL(safeNextPath(next), 'https://sophy.invalid');
  return url.pathname === '/admin/invitations/accept' ? url.searchParams.get('token') : null;
}

/** Returns a code for the mail sender only. Suppressed requests keep their decoy ID. */
export async function createOtpChallenge(
  challengeId: string, email: string, next?: string | null,
): Promise<string | null> {
  const normalized = normalizeEmail(email);
  return getDb().transaction(async (tx) => {
    // Serializes both resend suppression and invalidation across all app instances.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`otp:${normalized}`}, 0))`);
    const now = new Date();
    const recent = await tx.select({ createdAt: loginChallenges.createdAt })
      .from(loginChallenges)
      .where(and(eq(loginChallenges.email, normalized), gt(loginChallenges.createdAt, new Date(now.getTime() - 60 * 60_000))))
      .orderBy(desc(loginChallenges.createdAt));
    if (
      (recent[0] && now.getTime() - recent[0].createdAt.getTime() < OTP_RESEND_MS) ||
      recent.length >= 10 ||
      recent.filter((row) => now.getTime() - row.createdAt.getTime() < 15 * 60_000).length >= 5
    ) return null;

    const [existing] = await tx.select({ status: users.status }).from(users)
      .where(eq(users.email, normalized)).limit(1);
    if (existing?.status === 'inactive') return null;

    let invitationId: string | null = null;
    const invitationToken = invitationTokenFromNext(next);
    if (invitationToken) {
      const [invitation] = await tx.select({ id: projectInvitations.id })
        .from(projectInvitations)
        .innerJoin(projects, and(eq(projects.id, projectInvitations.projectId), eq(projects.status, 'active')))
        .where(and(
          eq(projectInvitations.tokenHash, hashToken(invitationToken)),
          eq(projectInvitations.email, normalized), isNull(projectInvitations.acceptedAt),
          isNull(projectInvitations.revokedAt), gt(projectInvitations.expiresAt, now),
        )).limit(1);
      if (!invitation) return null;
      invitationId = invitation.id;
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await tx.update(loginChallenges).set({ consumedAt: now })
      .where(and(eq(loginChallenges.email, normalized), isNull(loginChallenges.consumedAt)));
    await tx.insert(loginChallenges).values({
      id: challengeId, email: normalized, codeHash: hashOtp(challengeId, normalized, code),
      invitationId, createdAt: now, expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    });
    return code;
  });
}

async function verifiedIdentity(tx: Transaction, email: string, invitationId: string | null): Promise<AuthUser | null> {
  const [existing] = await tx.select({ id: users.id, email: users.email, status: users.status })
    .from(users).where(eq(users.email, email)).limit(1);
  const now = new Date();
  if (existing) {
    if (existing.status !== 'active') return null;
    await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, existing.id));
    return { id: existing.id, email: existing.email };
  }

  // OTP verifies ownership but invitation acceptance remains a separate action.
  // This avoids giving invitees an unwanted personal project before they join.
  if (invitationId) {
    const [invitation] = await tx.select({ id: projectInvitations.id })
      .from(projectInvitations)
      .innerJoin(projects, and(eq(projects.id, projectInvitations.projectId), eq(projects.status, 'active')))
      .where(and(eq(projectInvitations.id, invitationId), eq(projectInvitations.email, email),
        isNull(projectInvitations.acceptedAt), isNull(projectInvitations.revokedAt),
        gt(projectInvitations.expiresAt, now))).limit(1);
    if (!invitation) return null;
  }

  const userId = randomUUID();
  const [created] = await tx.insert(users).values({
    id: userId, email, role: 'editor', status: 'active', lastLoginAt: now,
  }).onConflictDoNothing({ target: users.email }).returning({ id: users.id, email: users.email });
  if (!created) {
    const [winner] = await tx.select({ id: users.id, email: users.email, status: users.status })
      .from(users).where(eq(users.email, email)).limit(1);
    return winner?.status === 'active' ? { id: winner.id, email: winner.email } : null;
  }
  if (invitationId) return created;

  const projectId = randomUUID();
  await tx.insert(projects).values({ id: projectId, name: 'My Project',
    slug: `my-project-${projectId.slice(0, 8)}`, createdByUserId: userId, status: 'active' });
  await tx.insert(projectMemberships).values({ projectId, userId, role: 'admin', status: 'active' });
  await tx.insert(projectSettings).values({ projectId });
  await tx.update(users).set({ defaultProjectId: projectId, onboardedAt: now }).where(eq(users.id, userId));
  await tx.insert(auditLog).values({ projectId, actor: email, action: 'project.create', target: projectId,
    after: { name: 'My Project', source: 'self_signup' } });
  return created;
}

/** A row lock keeps the attempt budget and successful redemption atomic. */
export async function consumeOtp(challengeId: string, code: string): Promise<AuthUser | null> {
  if (!UUID_RE.test(challengeId) || !/^\d{6}$/.test(code)) return null;
  return getDb().transaction(async (tx) => {
    const [challenge] = await tx.select().from(loginChallenges)
      .where(eq(loginChallenges.id, challengeId)).for('update');
    const now = new Date();
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= OTP_MAX_ATTEMPTS) return null;
    const matches = matchesOtp(challenge.codeHash, hashOtp(challengeId, challenge.email, code));
    const attempts = challenge.attempts + 1;
    await tx.update(loginChallenges).set({ attempts,
      consumedAt: matches || attempts >= OTP_MAX_ATTEMPTS ? now : null,
    }).where(eq(loginChallenges.id, challengeId));
    if (!matches) return null;
    return verifiedIdentity(tx, challenge.email, challenge.invitationId);
  });
}
