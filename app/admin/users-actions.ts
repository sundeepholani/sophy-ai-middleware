'use server';

/**
 * User-management mutations (admin-only). Creating a user inserts the row and
 * sends a magic-link invite (best-effort — the user can always request a fresh
 * link from the login page). Guards prevent locking everyone out: an admin can't
 * deactivate/demote themselves into a no-admin state, nor remove the last admin.
 */
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { users, auditLog, type UserRole } from '@/db/schema';
import { assertAdmin } from '@/lib/auth/viewer';
import { normalizeEmail, createLoginToken, buildVerifyUrl } from '@/lib/auth/magic-link';
import { sendEmail } from '@/lib/email/send';
import { env } from '@/lib/env';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function audit(actor: string, action: string, target: string, after: unknown): Promise<void> {
  await getDb().insert(auditLog).values({ actor, action, target, after: after as object });
}

async function requestOrigin(): Promise<string | null> {
  const explicit = env.appOrigin();
  if (explicit) return explicit;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!host) return null;
  const proto = h.get('x-forwarded-proto') ?? (env.isProd() ? 'https' : 'http');
  return `${proto}://${host}`;
}

function inviteHtml(url: string): string {
  return `
  <div style="font-family:system-ui,sans-serif;max-width:480px;color:#111">
    <h2 style="margin:0 0 8px">You've been invited to Sophy</h2>
    <p style="font-size:14px;margin:0 0 16px">Click below to sign in. This link works once and expires in 15 minutes; you can always request a new one from the sign-in page.</p>
    <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Sign in to Sophy</a></p>
  </div>`;
}

async function sendInvite(email: string, userId: string): Promise<void> {
  try {
    const origin = await requestOrigin();
    if (!origin) return;
    const raw = await createLoginToken(userId, email);
    const url = buildVerifyUrl(origin, raw);
    const sent = await sendEmail(email, "You've been invited to Sophy", inviteHtml(url));
    if (!sent && !env.isProd()) console.info(`[invite] DEV sign-in link for ${email}: ${url}`);
  } catch (err) {
    console.error('[invite] send failed', err);
  }
}

/** Block removing/demoting the last active admin (prevents a total lockout). */
async function ensureNotLastActiveAdmin(targetId: string): Promise<void> {
  const db = getDb();
  const [target] = await db
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  if (!target || target.role !== 'admin' || target.status !== 'active') return;
  const others = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), ne(users.id, targetId)))
    .limit(1);
  if (others.length === 0) throw new Error('Cannot remove the last active admin');
}

export async function createUser(input: { email: string; role: UserRole }): Promise<void> {
  const viewer = await assertAdmin();
  const email = normalizeEmail(input.email);
  if (!email || !EMAIL_RE.test(email)) throw new Error('Enter a valid email address');
  const role: UserRole = input.role === 'admin' ? 'admin' : 'editor';

  const [row] = await getDb()
    .insert(users)
    .values({ email, role, status: 'active' })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  if (!row) throw new Error('A user with that email already exists');

  await audit(viewer.email, 'user.create', row.id, { email, role });
  await sendInvite(email, row.id);
  revalidatePath('/admin/users');
}

export async function setUserStatus(input: { id: string; active: boolean }): Promise<void> {
  const viewer = await assertAdmin();
  if (input.id === viewer.userId && !input.active) {
    throw new Error("You can't deactivate your own account");
  }
  if (!input.active) await ensureNotLastActiveAdmin(input.id);
  await getDb()
    .update(users)
    .set({ status: input.active ? 'active' : 'inactive' })
    .where(eq(users.id, input.id));
  await audit(viewer.email, 'user.status', input.id, { active: input.active });
  revalidatePath('/admin/users');
}

export async function setUserRole(input: { id: string; role: UserRole }): Promise<void> {
  const viewer = await assertAdmin();
  const role: UserRole = input.role === 'admin' ? 'admin' : 'editor';
  if (role === 'editor') await ensureNotLastActiveAdmin(input.id); // demotion can't orphan admin
  await getDb().update(users).set({ role }).where(eq(users.id, input.id));
  await audit(viewer.email, 'user.role', input.id, { role });
  revalidatePath('/admin/users');
}
