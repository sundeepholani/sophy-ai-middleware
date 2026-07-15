import 'server-only';

import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  apiKeys,
  projectGatewayCredentials,
  projectInvitations,
  projectMemberships,
  projects,
  users,
  type GatewayCredentialHealth,
  type GatewayCredentialLifecycle,
  type GatewayCredentialSource,
  type MembershipStatus,
  type ProjectRole,
} from '@/db/schema';
import type { ProjectViewer } from '@/lib/auth/viewer';
import { hashToken } from '@/lib/auth/magic-link';
import { env } from '@/lib/env';
import { platformGatewayCredentialConflicts } from '@/lib/gateway/project-provider';

export interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
  role: ProjectRole;
  isDefault: boolean;
}

export async function listProjectsForUser(userId: string): Promise<ProjectListItem[]> {
  const rows = await getDb()
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      role: projectMemberships.role,
      defaultProjectId: users.defaultProjectId,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .innerJoin(users, eq(users.id, projectMemberships.userId))
    .where(
      and(
        eq(projectMemberships.userId, userId),
        eq(projectMemberships.status, 'active'),
        eq(projects.status, 'active'),
      ),
    )
    .orderBy(projects.name);

  return rows.map(({ defaultProjectId, ...project }) => ({
    ...project,
    isDefault: defaultProjectId === project.id,
  }));
}

/**
 * Record a deliberate project open for deterministic fallback selection. The
 * five-minute throttle avoids a write on every navigation inside one project.
 */
export async function touchProjectAccess(userId: string, projectId: string): Promise<void> {
  const now = new Date();
  await getDb()
    .update(projectMemberships)
    .set({ lastAccessedAt: now, updatedAt: now })
    .where(
      and(
        eq(projectMemberships.userId, userId),
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.status, 'active'),
        lt(projectMemberships.lastAccessedAt, new Date(now.getTime() - 5 * 60_000)),
      ),
    );
}

export type ProjectGatewayState = 'not_connected' | 'ready' | 'attention';

export interface ProjectGatewaySummary {
  projectId: string;
  state: ProjectGatewayState;
  isReady: boolean;
  credentialId: string | null;
  source: GatewayCredentialSource | null;
  lifecycle: GatewayCredentialLifecycle | null;
  health: GatewayCredentialHealth | null;
  lastFour: string | null;
  connectedAt: Date | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastFailureCode: string | null;
}

/** Safe credential metadata only; ciphertext and fingerprints never leave core. */
export async function getProjectGatewaySummary(
  projectId: string,
): Promise<ProjectGatewaySummary> {
  const [row] = await getDb()
    .select({
      projectStatus: projects.status,
      currentCredentialId: projects.currentGatewayCredentialId,
      credentialId: projectGatewayCredentials.id,
      credentialProjectId: projectGatewayCredentials.projectId,
      source: projectGatewayCredentials.source,
      lifecycle: projectGatewayCredentials.lifecycle,
      health: projectGatewayCredentials.health,
      lastFour: projectGatewayCredentials.secretLastFour,
      connectedAt: projectGatewayCredentials.createdAt,
      verifiedAt: projectGatewayCredentials.verifiedAt,
      lastCheckedAt: projectGatewayCredentials.lastCheckedAt,
      lastFailureCode: projectGatewayCredentials.lastFailureCode,
    })
    .from(projects)
    .leftJoin(
      projectGatewayCredentials,
      and(
        eq(projectGatewayCredentials.id, projects.currentGatewayCredentialId),
        eq(projectGatewayCredentials.projectId, projects.id),
      ),
    )
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row) throw new Error('not_found');
  const linked =
    !!row.currentCredentialId &&
    row.credentialId === row.currentCredentialId &&
    row.credentialProjectId === projectId;
  let platformCredentialReady = true;
  if (linked && row.source === 'platform_env') {
    const platformKey = env.aiGatewayApiKey()?.trim();
    if (!platformKey) {
      platformCredentialReady = false;
    } else {
      try {
        platformCredentialReady = !(await platformGatewayCredentialConflicts(
          projectId,
          platformKey,
        ));
      } catch {
        // Missing fingerprint configuration or a failed conflict check must not
        // make the migration bridge look healthy in the console.
        platformCredentialReady = false;
      }
    }
  }
  const isReady =
    linked &&
    row.projectStatus === 'active' &&
    row.lifecycle === 'available' &&
    row.health === 'healthy' &&
    platformCredentialReady;
  const state: ProjectGatewayState = !linked
    ? 'not_connected'
    : isReady
      ? 'ready'
      : 'attention';

  return {
    projectId,
    state,
    isReady,
    credentialId: linked ? row.credentialId : null,
    source: linked ? row.source : null,
    lifecycle: linked ? row.lifecycle : null,
    health: linked ? row.health : null,
    lastFour: linked ? row.lastFour : null,
    connectedAt: linked ? row.connectedAt : null,
    verifiedAt: linked ? row.verifiedAt : null,
    lastCheckedAt: linked ? row.lastCheckedAt : null,
    lastFailureCode: linked ? row.lastFailureCode : null,
  };
}

export interface ProjectMemberRow {
  userId: string;
  email: string;
  role: ProjectRole;
  status: MembershipStatus;
  joinedAt: Date;
  lastAccessedAt: Date;
  keyCount: number;
  isCurrentUser: boolean;
}

export async function listProjectMembers(
  viewer: ProjectViewer,
): Promise<ProjectMemberRow[]> {
  if (viewer.role !== 'admin') throw new Error('forbidden');
  const rows = await getDb()
    .select({
      userId: projectMemberships.userId,
      email: users.email,
      role: projectMemberships.role,
      status: projectMemberships.status,
      joinedAt: projectMemberships.joinedAt,
      lastAccessedAt: projectMemberships.lastAccessedAt,
      keyCount: sql<number>`(
        select count(*)::int
        from ${apiKeys}
        where ${apiKeys.projectId} = ${projectMemberships.projectId}
          and ${apiKeys.ownerUserId} = ${projectMemberships.userId}
      )`,
    })
    .from(projectMemberships)
    .innerJoin(users, eq(users.id, projectMemberships.userId))
    .where(eq(projectMemberships.projectId, viewer.projectId))
    .orderBy(users.email);
  return rows.map((row) => ({
    ...row,
    keyCount: Number(row.keyCount),
    isCurrentUser: row.userId === viewer.userId,
  }));
}

export interface ProjectInvitationRow {
  id: string;
  email: string;
  role: ProjectRole;
  invitedByUserId: string;
  invitedByEmail: string;
  expiresAt: Date;
  createdAt: Date;
  expired: boolean;
}

export interface ProjectInvitationPreview {
  projectName: string;
  email: string;
  role: ProjectRole;
  invitedByEmail: string;
  expiresAt: Date;
}

/**
 * Non-secret invitation details shown before the recipient explicitly accepts.
 * Only a currently usable token can reveal its email-bound invitation.
 */
export async function getProjectInvitationPreview(
  rawToken: string,
): Promise<ProjectInvitationPreview | null> {
  if (!rawToken) return null;
  const [invitation] = await getDb()
    .select({
      projectName: projects.name,
      email: projectInvitations.email,
      role: projectInvitations.role,
      invitedByEmail: users.email,
      expiresAt: projectInvitations.expiresAt,
    })
    .from(projectInvitations)
    .innerJoin(
      projects,
      and(
        eq(projects.id, projectInvitations.projectId),
        eq(projects.status, 'active'),
      ),
    )
    .innerJoin(users, eq(users.id, projectInvitations.invitedByUserId))
    .where(
      and(
        eq(projectInvitations.tokenHash, hashToken(rawToken)),
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt),
        sql`${projectInvitations.expiresAt} > now()`,
      ),
    )
    .limit(1);

  return invitation ?? null;
}

export async function listProjectInvitations(
  viewer: ProjectViewer,
): Promise<ProjectInvitationRow[]> {
  if (viewer.role !== 'admin') throw new Error('forbidden');
  const rows = await getDb()
    .select({
      id: projectInvitations.id,
      email: projectInvitations.email,
      role: projectInvitations.role,
      invitedByUserId: projectInvitations.invitedByUserId,
      invitedByEmail: sql<string>`(
        select ${users.email}
        from ${users}
        where ${users.id} = ${projectInvitations.invitedByUserId}
      )`,
      expiresAt: projectInvitations.expiresAt,
      createdAt: projectInvitations.createdAt,
    })
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.projectId, viewer.projectId),
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt),
      ),
    )
    .orderBy(desc(projectInvitations.createdAt));
  const now = Date.now();
  return rows.map((row) => ({ ...row, expired: row.expiresAt.getTime() <= now }));
}
