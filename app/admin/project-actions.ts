'use server';

import { randomBytes, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { and, asc, desc, eq, isNull, like, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  apiKeys,
  auditLog,
  evalSamples,
  kbDocuments,
  knowledgebases,
  projectGatewayCredentials,
  projectInvitations,
  projectMemberships,
  projectSettings,
  projects,
  users,
  type ProjectRole,
} from '@/db/schema';
import {
  assertProjectAdmin,
  requireIdentity,
  requireProjectViewer,
} from '@/lib/auth/viewer';
import { normalizeEmail, hashToken } from '@/lib/auth/magic-link';
import {
  encryptGatewayCredential,
} from '@/lib/gateway/credential-crypto';
import { validateGatewayCredential } from '@/lib/gateway/project-provider';
import { sendEmail, escapeHtml } from '@/lib/email/send';
import { env } from '@/lib/env';
import { CHANNELPLAY_PROJECT_ID } from '@/lib/projects/constants';

type Db = ReturnType<typeof getDb>;
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;

function projectPath(projectId: string, suffix = ''): string {
  return `/admin/p/${projectId}${suffix}`;
}

function revalidateProject(projectId: string): void {
  revalidatePath(projectPath(projectId));
  revalidatePath(projectPath(projectId, '/settings'));
  revalidatePath(projectPath(projectId, '/members'));
  revalidatePath(projectPath(projectId, '/keys'));
}

async function audit(
  db: Db | DbTx,
  projectId: string,
  actor: string,
  action: string,
  target: string,
  after: unknown,
): Promise<void> {
  await db.insert(auditLog).values({
    projectId,
    actor,
    action,
    target,
    after: after as object,
  });
}

function normalizedProjectName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('Project name is required');
  if (name.length > 120) throw new Error('Project name is too long');
  return name;
}

function projectSlug(name: string, projectId: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'project';
  return `${base}-${projectId.slice(0, 8)}`;
}

async function lockProject(tx: DbTx, projectId: string): Promise<void> {
  await tx.execute(sql`select id from ${projects} where ${projects.id} = ${projectId} for update`);
}

async function requireActiveAdminFloor(tx: DbTx, projectId: string): Promise<void> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(projectMemberships)
    .innerJoin(users, eq(users.id, projectMemberships.userId))
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.role, 'admin'),
        eq(projectMemberships.status, 'active'),
        eq(users.status, 'active'),
      ),
    );
  if (Number(row?.count ?? 0) < 1) throw new Error('last_project_admin');
}

async function fallbackProjectForUser(
  tx: DbTx,
  userId: string,
  excludedProjectId: string,
): Promise<string | null> {
  const [fallback] = await tx
    .select({ projectId: projectMemberships.projectId })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .where(
      and(
        eq(projectMemberships.userId, userId),
        ne(projectMemberships.projectId, excludedProjectId),
        eq(projectMemberships.status, 'active'),
        eq(projects.status, 'active'),
      ),
    )
    .orderBy(desc(projectMemberships.lastAccessedAt), asc(projectMemberships.projectId))
    .limit(1);
  return fallback?.projectId ?? null;
}

export async function createProject(input: { name: string }): Promise<{ projectId: string }> {
  const identity = await requireIdentity();
  const name = normalizedProjectName(input.name);
  const projectId = randomUUID();
  const slug = projectSlug(name, projectId);

  await getDb().transaction(async (tx) => {
    await tx.insert(projects).values({
      id: projectId,
      name,
      slug,
      status: 'active',
      createdByUserId: identity.userId,
    });
    await tx.insert(projectMemberships).values({
      projectId,
      userId: identity.userId,
      role: 'admin',
      status: 'active',
    });
    await tx.insert(projectSettings).values({ projectId });
    await audit(tx, projectId, identity.email, 'project.create', projectId, { name, slug });
  });

  revalidatePath('/admin');
  return { projectId };
}

/**
 * Idempotent recovery for an identity with no active projects. Concurrent
 * recovery submissions for the same identity serialize on a transaction lock,
 * so they cannot create multiple accidental "My Project" tenants.
 */
export async function ensureRecoveryProject(): Promise<{ projectId: string }> {
  const identity = await requireIdentity();
  const projectId = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${identity.userId}::text, 0))`,
    );

    const [existing] = await tx
      .select({
        projectId: projectMemberships.projectId,
        defaultProjectId: users.defaultProjectId,
      })
      .from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .innerJoin(users, eq(users.id, projectMemberships.userId))
      .where(
        and(
          eq(projectMemberships.userId, identity.userId),
          eq(projectMemberships.status, 'active'),
          eq(projects.status, 'active'),
        ),
      )
      .orderBy(
        desc(sql`${projectMemberships.projectId} = ${users.defaultProjectId}`),
        desc(projectMemberships.lastAccessedAt),
        asc(projectMemberships.projectId),
      )
      .limit(1);
    if (existing) {
      if (existing.defaultProjectId !== existing.projectId) {
        // Repair only the stale value we observed. A concurrent explicit
        // default choice wins instead of being overwritten by this old form.
        await tx
          .update(users)
          .set({ defaultProjectId: existing.projectId })
          .where(
            and(
              eq(users.id, identity.userId),
              existing.defaultProjectId
                ? eq(users.defaultProjectId, existing.defaultProjectId)
                : isNull(users.defaultProjectId),
            ),
          );
      }
      return existing.projectId;
    }

    const id = randomUUID();
    const name = 'My Project';
    const slug = projectSlug(name, id);
    await tx.insert(projects).values({
      id,
      name,
      slug,
      status: 'active',
      createdByUserId: identity.userId,
    });
    await tx.insert(projectMemberships).values({
      projectId: id,
      userId: identity.userId,
      role: 'admin',
      status: 'active',
    });
    await tx.insert(projectSettings).values({ projectId: id });
    await tx
      .update(users)
      .set({ defaultProjectId: id })
      .where(eq(users.id, identity.userId));
    await audit(tx, id, identity.email, 'project.create', id, { name, slug, recovery: true });
    return id;
  });

  revalidatePath('/admin');
  return { projectId };
}

export async function setDefaultProject(input: { projectId: string }): Promise<void> {
  const viewer = await requireProjectViewer(input.projectId);
  await getDb()
    .update(users)
    .set({ defaultProjectId: input.projectId })
    .where(eq(users.id, viewer.userId));
  revalidatePath('/admin');
  revalidateProject(input.projectId);
}

export async function renameProject(input: {
  projectId: string;
  name: string;
}): Promise<void> {
  const viewer = await assertProjectAdmin(input.projectId);
  const name = normalizedProjectName(input.name);
  await getDb().transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    await tx
      .update(projects)
      .set({ name, updatedAt: new Date() })
      .where(eq(projects.id, input.projectId));
    await audit(tx, input.projectId, viewer.email, 'project.rename', input.projectId, { name });
  });
  revalidateProject(input.projectId);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export async function connectProjectGateway(input: {
  projectId: string;
  apiKey: string;
}): Promise<void> {
  const viewer = await assertProjectAdmin(input.projectId);
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error('gateway_invalid');
  const platformKey = env.aiGatewayApiKey()?.trim();
  if (
    input.projectId !== CHANNELPLAY_PROJECT_ID &&
    platformKey &&
    apiKey === platformKey
  ) {
    throw new Error('gateway_in_use');
  }
  try {
    await validateGatewayCredential(apiKey);
  } catch {
    throw new Error('gateway_invalid');
  }

  const credentialId = randomUUID();
  const envelope = encryptGatewayCredential({
    projectId: input.projectId,
    credentialId,
    secret: apiKey,
  });
  const now = new Date();
  try {
    await getDb().transaction(async (tx) => {
      await lockProject(tx, input.projectId);
      const [project] = await tx
        .select({ currentCredentialId: projects.currentGatewayCredentialId })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);
      if (!project) throw new Error('not_found');

      if (project.currentCredentialId) {
        await tx
          .update(projectGatewayCredentials)
          .set({
            lifecycle: 'replaced',
            encryptedSecret: null,
            encryptionNonce: null,
            encryptionTag: null,
            replacedAt: now,
          })
          .where(
            and(
              eq(projectGatewayCredentials.projectId, input.projectId),
              eq(projectGatewayCredentials.id, project.currentCredentialId),
              eq(projectGatewayCredentials.lifecycle, 'available'),
            ),
          );
      }

      await tx.insert(projectGatewayCredentials).values({
        id: credentialId,
        projectId: input.projectId,
        source: 'encrypted_api_key',
        lifecycle: 'available',
        health: 'healthy',
        ...envelope,
        verifiedAt: now,
        lastCheckedAt: now,
        createdByUserId: viewer.userId,
      });
      await tx
        .update(projects)
        .set({
          currentGatewayCredentialId: credentialId,
          gatewayCredentialRevision: sql`${projects.gatewayCredentialRevision} + 1`,
          updatedAt: now,
        })
        .where(eq(projects.id, input.projectId));

      // Make credential-blocked background work immediately eligible again.
      await tx
        .update(kbDocuments)
        .set({ errorMessage: null })
        .where(
          and(
            eq(kbDocuments.projectId, input.projectId),
            eq(kbDocuments.status, 'pending'),
            like(kbDocuments.errorMessage, 'project_gateway_unavailable%'),
          ),
        );
      await tx
        .update(evalSamples)
        .set({ errorMessage: null, createdAt: now })
        .where(
          and(
            eq(evalSamples.projectId, input.projectId),
            eq(evalSamples.status, 'pending'),
            eq(evalSamples.errorMessage, 'project_gateway_unavailable'),
          ),
        );
      await audit(
        tx,
        input.projectId,
        viewer.email,
        project.currentCredentialId ? 'gateway.rotate' : 'gateway.connect',
        credentialId,
        {
          lastFour: envelope.secretLastFour,
          fingerprint: envelope.secretFingerprint,
        },
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error('gateway_in_use');
    throw error;
  }
  revalidateProject(input.projectId);
}

export async function disconnectProjectGateway(input: {
  projectId: string;
}): Promise<void> {
  const viewer = await assertProjectAdmin(input.projectId);
  const now = new Date();
  await getDb().transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    const [project] = await tx
      .select({ currentCredentialId: projects.currentGatewayCredentialId })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project) throw new Error('not_found');
    if (project.currentCredentialId) {
      await tx
        .update(projectGatewayCredentials)
        .set({
          lifecycle: 'disconnected',
          encryptedSecret: null,
          encryptionNonce: null,
          encryptionTag: null,
          disconnectedAt: now,
        })
        .where(
          and(
            eq(projectGatewayCredentials.projectId, input.projectId),
            eq(projectGatewayCredentials.id, project.currentCredentialId),
          ),
        );
    }
    await tx
      .update(projects)
      .set({
        currentGatewayCredentialId: null,
        gatewayCredentialRevision: sql`${projects.gatewayCredentialRevision} + 1`,
        updatedAt: now,
      })
      .where(eq(projects.id, input.projectId));
    await audit(
      tx,
      input.projectId,
      viewer.email,
      'gateway.disconnect',
      project.currentCredentialId ?? input.projectId,
      null,
    );
  });
  revalidateProject(input.projectId);
}

async function requestOrigin(): Promise<string | null> {
  const explicit = env.appOrigin();
  if (explicit) return explicit;
  if (env.isProd()) return null;
  const requestHeaders = await headers();
  const host = requestHeaders.get('host');
  if (!host) return null;
  return `${requestHeaders.get('x-forwarded-proto') ?? 'http'}://${host}`;
}

function invitationUrl(origin: string, rawToken: string): string {
  const url = new URL('/admin/invitations/accept', origin);
  url.searchParams.set('token', rawToken);
  return url.toString();
}

function invitationHtml(projectName: string, role: ProjectRole, url: string): string {
  return `
    <div style="font-family:system-ui,sans-serif;max-width:520px;color:#111">
      <h2 style="margin:0 0 8px">Join ${escapeHtml(projectName)} in Sophy</h2>
      <p style="font-size:14px;margin:0 0 16px">You were invited as ${role === 'admin' ? 'a Project Admin' : 'an Editor'}.</p>
      <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Review invitation</a></p>
      <p style="font-size:12px;color:#777;margin-top:16px">This link expires in 7 days. Joining is explicit; opening the email does not accept it.</p>
    </div>`;
}

async function deliverInvitation(input: {
  email: string;
  projectName: string;
  role: ProjectRole;
  rawToken: string;
}): Promise<void> {
  const origin = await requestOrigin();
  if (!origin) return;
  const url = invitationUrl(origin, input.rawToken);
  try {
    const sent = await sendEmail(
      input.email,
      `Join ${input.projectName} in Sophy`,
      invitationHtml(input.projectName, input.role, url),
    );
    if (!sent && !env.isProd()) console.info(`[invite] DEV link for ${input.email}: ${url}`);
  } catch (error) {
    console.error('[invite] email delivery failed', {
      projectName: input.projectName,
      email: input.email,
      error,
    });
  }
}

function newInvitationToken(): { raw: string; hash: string; expiresAt: Date } {
  const raw = randomBytes(32).toString('base64url');
  return {
    raw,
    hash: hashToken(raw),
    expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
  };
}

export async function inviteProjectMember(input: {
  projectId: string;
  email: string;
  role: ProjectRole;
}): Promise<void> {
  const viewer = await assertProjectAdmin(input.projectId);
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw new Error('Enter a valid email address');
  const role: ProjectRole = input.role === 'admin' ? 'admin' : 'editor';
  const token = newInvitationToken();

  await getDb().transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    const [existingMember] = await tx
      .select({ userId: projectMemberships.userId })
      .from(projectMemberships)
      .innerJoin(users, eq(users.id, projectMemberships.userId))
      .where(
        and(
          eq(projectMemberships.projectId, input.projectId),
          eq(users.email, email),
        ),
      )
      .limit(1);
    if (existingMember) throw new Error('already_member');

    const [pending] = await tx
      .select({ id: projectInvitations.id, expiresAt: projectInvitations.expiresAt })
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.projectId, input.projectId),
          eq(projectInvitations.email, email),
          isNull(projectInvitations.acceptedAt),
          isNull(projectInvitations.revokedAt),
        ),
      )
      .limit(1);

    if (pending && pending.expiresAt <= new Date()) {
      await tx
        .update(projectInvitations)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(projectInvitations.id, pending.id),
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
          ),
        );
    }
    if (pending && pending.expiresAt > new Date()) {
      await tx
        .update(projectInvitations)
        .set({
          role,
          tokenHash: token.hash,
          expiresAt: token.expiresAt,
          invitedByUserId: viewer.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projectInvitations.id, pending.id),
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
          ),
        );
    } else {
      await tx.insert(projectInvitations).values({
        projectId: input.projectId,
        email,
        role,
        invitedByUserId: viewer.userId,
        tokenHash: token.hash,
        expiresAt: token.expiresAt,
      });
    }
    await audit(tx, input.projectId, viewer.email, 'member.invite', email, { role });
  });

  await deliverInvitation({
    email,
    projectName: viewer.projectName,
    role,
    rawToken: token.raw,
  });
  revalidateProject(input.projectId);
}

export async function changeProjectMemberRole(input: {
  projectId: string;
  userId: string;
  role: ProjectRole;
}): Promise<void> {
  const viewer = await assertProjectAdmin(input.projectId);
  const role: ProjectRole = input.role === 'admin' ? 'admin' : 'editor';
  await getDb().transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    const changed = await tx
      .update(projectMemberships)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(projectMemberships.projectId, input.projectId),
          eq(projectMemberships.userId, input.userId),
        ),
      )
      .returning({ userId: projectMemberships.userId });
    if (!changed.length) throw new Error('not_found');
    await requireActiveAdminFloor(tx, input.projectId);
    await audit(tx, input.projectId, viewer.email, 'member.role', input.userId, { role });
  });
  revalidateProject(input.projectId);
}

export async function setProjectMemberRole(input: {
  projectId: string;
  userId: string;
  role: ProjectRole;
}): Promise<void> {
  return changeProjectMemberRole(input);
}

export async function changeProjectMemberStatus(input: {
  projectId: string;
  userId: string;
  active: boolean;
}): Promise<void> {
  const viewer = await assertProjectAdmin(input.projectId);
  await getDb().transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    const status = input.active ? 'active' : 'suspended';
    if (!input.active) {
      const fallbackProjectId = await fallbackProjectForUser(
        tx,
        input.userId,
        input.projectId,
      );
      await tx
        .update(users)
        .set({ defaultProjectId: fallbackProjectId })
        .where(
          and(
            eq(users.id, input.userId),
            eq(users.defaultProjectId, input.projectId),
          ),
        );
    }
    const changed = await tx
      .update(projectMemberships)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(projectMemberships.projectId, input.projectId),
          eq(projectMemberships.userId, input.userId),
        ),
      )
      .returning({ userId: projectMemberships.userId });
    if (!changed.length) throw new Error('not_found');
    await requireActiveAdminFloor(tx, input.projectId);
    await audit(tx, input.projectId, viewer.email, 'member.status', input.userId, { status });
  });
  revalidateProject(input.projectId);
}

export async function removeProjectMember(input: {
  projectId: string;
  userId: string;
}): Promise<void> {
  const viewer = await assertProjectAdmin(input.projectId);
  await getDb().transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    const [membership] = await tx
      .select({ userId: projectMemberships.userId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.projectId, input.projectId),
          eq(projectMemberships.userId, input.userId),
        ),
      )
      .limit(1);
    if (!membership) throw new Error('not_found');

    await tx
      .update(apiKeys)
      .set({ ownerUserId: null })
      .where(
        and(
          eq(apiKeys.projectId, input.projectId),
          eq(apiKeys.ownerUserId, input.userId),
        ),
      );
    await tx
      .update(knowledgebases)
      .set({ ownerUserId: null })
      .where(
        and(
          eq(knowledgebases.projectId, input.projectId),
          eq(knowledgebases.ownerUserId, input.userId),
        ),
      );

    const fallbackProjectId = await fallbackProjectForUser(
      tx,
      input.userId,
      input.projectId,
    );
    await tx
      .update(users)
      .set({ defaultProjectId: fallbackProjectId })
      .where(
        and(
          eq(users.id, input.userId),
          eq(users.defaultProjectId, input.projectId),
        ),
      );
    await tx
      .delete(projectMemberships)
      .where(
        and(
          eq(projectMemberships.projectId, input.projectId),
          eq(projectMemberships.userId, input.userId),
        ),
      );
    await requireActiveAdminFloor(tx, input.projectId);
    await audit(tx, input.projectId, viewer.email, 'member.remove', input.userId, null);
  });
  revalidateProject(input.projectId);
}

export async function changeProjectInvitationRole(input: {
  projectId: string;
  invitationId: string;
  role: ProjectRole;
}): Promise<void> {
  const viewer = await assertProjectAdmin(input.projectId);
  const role: ProjectRole = input.role === 'admin' ? 'admin' : 'editor';
  await getDb().transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    const updated = await tx
      .update(projectInvitations)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(projectInvitations.projectId, input.projectId),
          eq(projectInvitations.id, input.invitationId),
          isNull(projectInvitations.acceptedAt),
          isNull(projectInvitations.revokedAt),
        ),
      )
      .returning({ id: projectInvitations.id });
    if (!updated.length) throw new Error('not_found');
    await audit(
      tx,
      input.projectId,
      viewer.email,
      'invitation.role',
      input.invitationId,
      { role },
    );
  });
  revalidateProject(input.projectId);
}

export async function setProjectInvitationRole(input: {
  projectId: string;
  invitationId: string;
  role: ProjectRole;
}): Promise<void> {
  return changeProjectInvitationRole(input);
}

export async function resendProjectInvitation(input: {
  projectId: string;
  invitationId: string;
}): Promise<void> {
  const viewer = await assertProjectAdmin(input.projectId);
  const token = newInvitationToken();
  const invitation = await getDb().transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    const [updated] = await tx
      .update(projectInvitations)
      .set({
        tokenHash: token.hash,
        expiresAt: token.expiresAt,
        invitedByUserId: viewer.userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectInvitations.projectId, input.projectId),
          eq(projectInvitations.id, input.invitationId),
          isNull(projectInvitations.acceptedAt),
          isNull(projectInvitations.revokedAt),
        ),
      )
      .returning({
        email: projectInvitations.email,
        role: projectInvitations.role,
      });
    if (!updated) throw new Error('not_found');
    await audit(
      tx,
      input.projectId,
      viewer.email,
      'invitation.resend',
      input.invitationId,
      null,
    );
    return updated;
  });
  await deliverInvitation({
    email: invitation.email,
    projectName: viewer.projectName,
    role: invitation.role,
    rawToken: token.raw,
  });
  revalidateProject(input.projectId);
}

export async function revokeProjectInvitation(input: {
  projectId: string;
  invitationId: string;
}): Promise<void> {
  const viewer = await assertProjectAdmin(input.projectId);
  await getDb().transaction(async (tx) => {
    await lockProject(tx, input.projectId);
    const updated = await tx
      .update(projectInvitations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(projectInvitations.projectId, input.projectId),
          eq(projectInvitations.id, input.invitationId),
          isNull(projectInvitations.acceptedAt),
          isNull(projectInvitations.revokedAt),
        ),
      )
      .returning({ id: projectInvitations.id });
    if (!updated.length) throw new Error('not_found');
    await audit(
      tx,
      input.projectId,
      viewer.email,
      'invitation.revoke',
      input.invitationId,
      null,
    );
  });
  revalidateProject(input.projectId);
}
