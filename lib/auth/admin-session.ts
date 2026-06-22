/**
 * Operator session helpers (route handlers / server components).
 *
 * The session is an httpOnly, SameSite=Strict iron-session cookie scoped to
 * /admin + /api/admin (see proxy.ts). Client `mw_*` keys never grant console
 * access, and the console cookie never grants proxy access. Login is passwordless
 * (magic link) — see lib/auth/magic-link.ts; there is no stored password.
 */
import { cookies } from 'next/headers';
import { getIronSession, type IronSession } from 'iron-session';
import {
  sessionOptions,
  isAuthenticated as isAuthenticatedSession,
  isAdminSession,
  type AdminSession,
  type SessionRole,
} from '@/lib/auth/session-config';

export type { AdminSession };

/** Session bound to the Next.js cookie store (route handlers / server components). */
export async function getSession(): Promise<IronSession<AdminSession>> {
  return getIronSession<AdminSession>(await cookies(), sessionOptions());
}

/** True for any signed-in operator (admin or editor). */
export async function isAuthenticated(): Promise<boolean> {
  return isAuthenticatedSession(await getSession());
}

/** True only for an admin (new role flag, or a legacy single-admin cookie). */
export async function isAdminAuthed(): Promise<boolean> {
  return isAdminSession(await getSession());
}

export interface CurrentUser {
  userId: string;
  role: SessionRole;
  email: string;
}

/** The signed-in operator, or null (legacy admin cookies carry no userId). */
export async function currentUser(): Promise<CurrentUser | null> {
  const s = await getSession();
  if (s.userId && s.role && s.email) {
    return { userId: s.userId, role: s.role, email: s.email };
  }
  return null;
}
