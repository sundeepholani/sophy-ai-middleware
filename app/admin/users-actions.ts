'use server';

/**
 * User-management mutations (admin-only). Creating a user inserts the row and
 * sends a magic-link invite (best-effort — the user can always request a fresh
 * link from the login page). Guards prevent locking everyone out: an admin can't
 * deactivate/demote themselves into a no-admin state, nor remove the last admin.
 */
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { and, eq, sql } from 'drizzle-orm';
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

/**
 * Mint the invite sign-in link and try to email it. Returns the link so the admin
 * can always share it directly — email delivery to a brand-new address is the
 * least reliable step (ZeptoMail test-mode recipient limits, spam, etc.), and the
 * admin shouldn't be blocked on it.
 */
async function sendInvite(email: string, userId: string): Promise<{ inviteUrl: string | null; emailed: boolean }> {
  const origin = await requestOrigin();
  if (!origin) return { inviteUrl: null, emailed: false };
  const raw = await createLoginToken(userId, email);
  const inviteUrl = buildVerifyUrl(origin, raw);
  let emailed = false;
  try {
    emailed = await sendEmail(email, "You've been invited to Sophy", inviteHtml(inviteUrl));
    if (!emailed) console.warn(`[invite] email not sent (ZeptoMail unconfigured) for ${email}`);
  } catch (err) {
    console.error(`[invite] email send failed for ${email}:`, err);
  }
  return { inviteUrl, emailed };
}

// Constant key serializing all admin-floor mutations. Without it, two concurrent
// demotions/deactivations could each observe the other as still-active and both
// commit, orphaning the system with zero admins (TOCTOU). The advisory xact lock
// makes the check-and-mutate atomic; the second txn blocks, then sees the truth.
const ADMIN_FLOOR_LOCK = 487213;

/**
 * Set a single column on a user inside a serialized transaction, rolling back if
 * the change would leave zero active admins. The advisory xact lock serializes all
 * admin-floor mutations so a TOCTOU race can't orphan the system with no admins.
 */
async function setUserFieldWithAdminFloor(id: string, patch: Partial<typeof users.$inferInsert>): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_FLOOR_LOCK})`);
    await tx.update(users).set(patch).where(eq(users.id, id));
    const [row] = await tx
      .select({ n: sql<string>`count(*)` })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));
    if (Number(row?.n ?? 0) === 0) throw new Error('Cannot remove the last active admin');
  });
}

export async function createUser(
  input: { email: string; role: UserRole },
): Promise<{ inviteUrl: string | null; emailed: boolean }> {
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
  const { inviteUrl, emailed } = await sendInvite(email, row.id);
  revalidatePath('/admin/users');
  return { inviteUrl, emailed };
}

export async function setUserStatus(input: { id: string; active: boolean }): Promise<void> {
  const viewer = await assertAdmin();
  if (input.id === viewer.userId && !input.active) {
    throw new Error("You can't deactivate your own account");
  }
  if (input.active) {
    await getDb().update(users).set({ status: 'active' }).where(eq(users.id, input.id));
  } else {
    await setUserFieldWithAdminFloor(input.id, { status: 'inactive' });
  }
  await audit(viewer.email, 'user.status', input.id, { active: input.active });
  revalidatePath('/admin/users');
}

export async function setUserRole(input: { id: string; role: UserRole }): Promise<void> {
  const viewer = await assertAdmin();
  const role: UserRole = input.role === 'admin' ? 'admin' : 'editor';
  if (role === 'admin') {
    await getDb().update(users).set({ role }).where(eq(users.id, input.id));
  } else {
    await setUserFieldWithAdminFloor(input.id, { role }); // demotion can't orphan admin
  }
  await audit(viewer.email, 'user.role', input.id, { role });
  revalidatePath('/admin/users');
}
