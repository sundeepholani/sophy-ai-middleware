/**
 * Authorization layer for the admin console (server-only).
 *
 * A Viewer is the signed-in operator. Admins may act on everything; editors may
 * act only on keys they own. The guards here are the single source of truth used
 * by every server action, and scopeToOwner() is the single source of truth used
 * by every read query — so a new surface can't accidentally leak across owners.
 */
import { eq, inArray, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { getDb } from '@/db/client';
import { apiKeys, evalRuns, users } from '@/db/schema';
import { currentUser, type CurrentUser } from '@/lib/auth/admin-session';

export type Viewer = CurrentUser; // { userId, role, email }

/**
 * The signed-in operator, or null. Identity comes from the signed cookie, but the
 * role and active status are authoritative in Postgres and re-checked on EVERY
 * request — so deactivation and role changes take effect immediately (like key
 * revocation), not only when the 8h cookie expires. (Legacy single-admin cookies
 * have no userId → null → must re-login via magic link.)
 */
export async function getViewer(): Promise<Viewer | null> {
  const s = await currentUser();
  if (!s) return null;
  const [u] = await getDb()
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, s.userId))
    .limit(1);
  if (!u || u.status !== 'active') return null;
  return { userId: s.userId, role: u.role, email: s.email };
}

export async function requireViewer(): Promise<Viewer> {
  const v = await getViewer();
  if (!v) throw new Error('unauthorized');
  return v;
}

export function isAdmin(v: Viewer): boolean {
  return v.role === 'admin';
}

/** Admin-only. Returns the viewer (for audit attribution). */
export async function assertAdmin(): Promise<Viewer> {
  const v = await requireViewer();
  if (v.role !== 'admin') throw new Error('forbidden');
  return v;
}

/** Any active signed-in operator (admin or editor). */
export async function assertUser(): Promise<Viewer> {
  return requireViewer();
}

/**
 * Allow if the viewer is an admin OR owns the key. Returns the viewer + the key's
 * current owner (so callers don't re-fetch). Throws 'not_found' / 'forbidden'.
 */
export async function assertCanManageKey(
  keyId: string,
): Promise<{ viewer: Viewer; ownerUserId: string | null; model: string; status: string }> {
  const v = await requireViewer();
  const [key] = await getDb()
    .select({ ownerUserId: apiKeys.ownerUserId, model: apiKeys.model, status: apiKeys.status })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1);
  if (!key) throw new Error('not_found');
  if (v.role !== 'admin' && key.ownerUserId !== v.userId) throw new Error('forbidden');
  return { viewer: v, ownerUserId: key.ownerUserId, model: key.model, status: key.status };
}

/** Allow if the viewer may manage the key that owns this eval run. */
export async function assertCanManageRun(
  runId: string,
): Promise<{ viewer: Viewer; apiKeyId: string }> {
  const v = await requireViewer();
  const [run] = await getDb()
    .select({ apiKeyId: evalRuns.apiKeyId })
    .from(evalRuns)
    .where(eq(evalRuns.id, runId))
    .limit(1);
  if (!run) throw new Error('not_found');
  if (v.role !== 'admin') {
    const [key] = await getDb()
      .select({ ownerUserId: apiKeys.ownerUserId })
      .from(apiKeys)
      .where(eq(apiKeys.id, run.apiKeyId))
      .limit(1);
    if (!key || key.ownerUserId !== v.userId) throw new Error('forbidden');
  }
  return { viewer: v, apiKeyId: run.apiKeyId };
}

/**
 * A condition restricting a query to the viewer's owned keys, applied to a column
 * holding an api_key id. Returns undefined for admins (no restriction) — and since
 * drizzle's and()/where() ignore undefined, admins pass through unfiltered.
 *
 * Editors get a correlated subquery (IN (SELECT id FROM api_keys WHERE owner=…)),
 * which is empty-set-correct: an editor with zero keys sees zero rows.
 */
export function scopeToOwner(viewer: Viewer, apiKeyIdColumn: AnyPgColumn): SQL | undefined {
  if (viewer.role === 'admin') return undefined;
  return inArray(
    apiKeyIdColumn,
    getDb().select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.ownerUserId, viewer.userId)),
  );
}
