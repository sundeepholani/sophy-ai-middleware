/**
 * Identity and project authorization for the operator console.
 *
 * The cookie identifies only a user. Every guard reloads the active identity,
 * membership, project, and project-local role from Postgres. Project IDs always
 * come from the route/action input and are included in resource predicates.
 */
import { cache } from 'react';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { getDb } from '@/db/client';
import {
  apiKeys,
  evalRuns,
  projectMemberships,
  projects,
  users,
  type ProjectRole,
  type ProjectStatus,
} from '@/db/schema';
import { currentUser } from '@/lib/auth/admin-session';

export interface IdentityViewer {
  userId: string;
  email: string;
  defaultProjectId: string | null;
}

export interface ProjectViewer {
  userId: string;
  email: string;
  role: ProjectRole;
  projectId: string;
  projectName: string;
  projectSlug: string;
  projectStatus: ProjectStatus;
  defaultProjectId: string | null;
}

/** Project viewer alias used by the admin query layer. */
export type Viewer = ProjectViewer;

export const getIdentityViewer = cache(async (): Promise<IdentityViewer | null> => {
  const sessionIdentity = await currentUser();
  if (!sessionIdentity) return null;

  const [identity] = await getDb()
    .select({
      userId: users.id,
      email: users.email,
      status: users.status,
      defaultProjectId: users.defaultProjectId,
    })
    .from(users)
    .where(eq(users.id, sessionIdentity.userId))
    .limit(1);
  if (!identity || identity.status !== 'active') return null;
  return {
    userId: identity.userId,
    email: identity.email,
    defaultProjectId: identity.defaultProjectId,
  };
});

export async function requireIdentity(): Promise<IdentityViewer> {
  const identity = await getIdentityViewer();
  if (!identity) throw new Error('unauthorized');
  return identity;
}

const getProjectViewerForUser = cache(
  async (userId: string, projectId: string): Promise<ProjectViewer | null> => {
    const [row] = await getDb()
      .select({
        userId: users.id,
        email: users.email,
        userStatus: users.status,
        defaultProjectId: users.defaultProjectId,
        role: projectMemberships.role,
        membershipStatus: projectMemberships.status,
        projectId: projects.id,
        projectName: projects.name,
        projectSlug: projects.slug,
        projectStatus: projects.status,
      })
      .from(users)
      .innerJoin(
        projectMemberships,
        and(
          eq(projectMemberships.userId, users.id),
          eq(projectMemberships.projectId, projectId),
        ),
      )
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .where(eq(users.id, userId))
      .limit(1);

    if (
      !row ||
      row.userStatus !== 'active' ||
      row.membershipStatus !== 'active' ||
      row.projectStatus !== 'active'
    ) {
      return null;
    }
    return {
      userId: row.userId,
      email: row.email,
      role: row.role,
      projectId: row.projectId,
      projectName: row.projectName,
      projectSlug: row.projectSlug,
      projectStatus: row.projectStatus,
      defaultProjectId: row.defaultProjectId,
    };
  },
);

/** Resolve an active project membership for the signed-in identity. */
export async function getProjectViewer(projectId: string): Promise<ProjectViewer | null> {
  const identity = await getIdentityViewer();
  if (!identity) return null;
  return getProjectViewerForUser(identity.userId, projectId);
}

export async function requireProjectViewer(projectId: string): Promise<ProjectViewer> {
  const viewer = await getProjectViewer(projectId);
  if (!viewer) throw new Error('forbidden');
  return viewer;
}

export async function assertProjectAdmin(projectId: string): Promise<ProjectViewer> {
  const viewer = await requireProjectViewer(projectId);
  if (viewer.role !== 'admin') throw new Error('forbidden');
  return viewer;
}

export async function assertCanManageKey(
  projectId: string,
  keyId: string,
): Promise<{
  viewer: ProjectViewer;
  ownerUserId: string | null;
  model: string;
  status: string;
  name: string;
}> {
  const viewer = await requireProjectViewer(projectId);
  const [key] = await getDb()
    .select({
      ownerUserId: apiKeys.ownerUserId,
      model: apiKeys.model,
      status: apiKeys.status,
      name: apiKeys.name,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.projectId, projectId), eq(apiKeys.id, keyId)))
    .limit(1);
  if (!key) throw new Error('not_found');
  if (viewer.role !== 'admin' && key.ownerUserId !== viewer.userId) {
    throw new Error('forbidden');
  }
  return { viewer, ...key };
}

export async function assertCanManageRun(
  projectId: string,
  runId: string,
): Promise<{ viewer: ProjectViewer; apiKeyId: string }> {
  const viewer = await requireProjectViewer(projectId);
  const [run] = await getDb()
    .select({ apiKeyId: evalRuns.apiKeyId })
    .from(evalRuns)
    .where(and(eq(evalRuns.projectId, projectId), eq(evalRuns.id, runId)))
    .limit(1);
  if (!run) throw new Error('not_found');
  if (viewer.role !== 'admin') {
    const [key] = await getDb()
      .select({ ownerUserId: apiKeys.ownerUserId })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.projectId, projectId),
          eq(apiKeys.id, run.apiKeyId),
        ),
      )
      .limit(1);
    if (!key || key.ownerUserId !== viewer.userId) throw new Error('forbidden');
  }
  return { viewer, apiKeyId: run.apiKeyId };
}

/**
 * Owner filtering is always combined with the caller's project predicate.
 * Admin means all resources in this project, never all projects.
 */
export function scopeToOwner(
  viewer: ProjectViewer,
  apiKeyIdColumn: AnyPgColumn,
): SQL | undefined {
  if (viewer.role === 'admin') return undefined;
  return inArray(
    apiKeyIdColumn,
    getDb()
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.projectId, viewer.projectId),
          eq(apiKeys.ownerUserId, viewer.userId),
        ),
      ),
  );
}
