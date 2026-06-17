/**
 * Admin authentication — a single operator account (v1).
 *
 * This is intentionally separate from client API-key auth: the admin session is
 * an httpOnly, SameSite=Strict iron-session cookie scoped to /admin + /api/admin
 * (see middleware.ts). Client `mw_*` keys never grant admin access, and the
 * admin cookie never grants proxy access.
 *
 * The admin password is stored only as a bcrypt hash (ADMIN_PASSWORD_HASH).
 * Upgrade path to Clerk/SSO + per-user audit is documented in the plan.
 */
import { cookies } from 'next/headers';
import { getIronSession, type IronSession } from 'iron-session';
import bcrypt from 'bcryptjs';
import { env } from '@/lib/env';
import { sessionOptions, type AdminSession } from '@/lib/auth/session-config';

export type { AdminSession };

/** Session bound to the Next.js cookie store (route handlers / server components). */
export async function getSession(): Promise<IronSession<AdminSession>> {
  return getIronSession<AdminSession>(await cookies(), sessionOptions());
}

export async function isAdminAuthed(): Promise<boolean> {
  const session = await getSession();
  return session.isAdmin === true;
}

/** Verify operator credentials against the configured username + bcrypt hash. */
export async function verifyAdminCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  if (username !== env.adminUsername()) {
    // Still run a comparison to avoid a username-timing oracle.
    await bcrypt.compare(password, env.adminPasswordHash()).catch(() => false);
    return false;
  }
  try {
    return await bcrypt.compare(password, env.adminPasswordHash());
  } catch {
    return false;
  }
}
