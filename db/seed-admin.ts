/**
 * Bootstrap the first admin from BOOTSTRAP_ADMIN_EMAIL.
 *
 * Two entry points, both idempotent and safe to call repeatedly:
 *  - seedBootstrapAdmin(): explicit seed (e.g. `pnpm db:seed` after a migrate).
 *  - maybeBootstrapAdminForLogin(): lazy self-heal on the login path so the very
 *    first sign-in can never be locked out, even if the explicit seed was skipped.
 * Neither ever overwrites or demotes an existing user.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { env } from '@/lib/env';
import { normalizeEmail, findActiveUserByEmail, type AuthUser } from '@/lib/auth/magic-link';

/** Insert the bootstrap admin if it doesn't already exist. No-op when the env is unset. */
export async function seedBootstrapAdmin(): Promise<void> {
  const raw = env.bootstrapAdminEmail();
  if (!raw) return;
  await getDb()
    .insert(users)
    .values({ email: normalizeEmail(raw), role: 'admin', status: 'active' })
    .onConflictDoNothing({ target: users.email });
}

/**
 * If a login is attempted for BOOTSTRAP_ADMIN_EMAIL and there are NO admins yet,
 * create the admin row and return it — so bootstrap can't be locked out. Returns
 * null otherwise (unknown email, not the bootstrap email, or admins already exist).
 */
export async function maybeBootstrapAdminForLogin(email: string): Promise<AuthUser | null> {
  const boot = env.bootstrapAdminEmail();
  if (!boot) return null;
  const norm = normalizeEmail(email);
  if (norm !== normalizeEmail(boot)) return null;

  const db = getDb();
  const existingAdmin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  if (existingAdmin.length > 0) return null; // an admin already exists — don't auto-create

  const [row] = await db
    .insert(users)
    .values({ email: norm, role: 'admin', status: 'active' })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id, email: users.email, role: users.role });
  if (row) return { id: row.id, email: row.email, role: row.role };
  // Lost a race (created concurrently) — read it back.
  return findActiveUserByEmail(norm);
}
