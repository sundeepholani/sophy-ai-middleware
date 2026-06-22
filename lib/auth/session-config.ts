/**
 * Admin session config shared by route handlers (admin-session.ts) and the
 * edge middleware. Kept free of `next/headers`/bcrypt so it is safe to import
 * from middleware.
 */
import type { SessionOptions } from 'iron-session';
import { env } from '@/lib/env';

export type SessionRole = 'admin' | 'editor';

export interface AdminSession {
  userId?: string;
  role?: SessionRole;
  email?: string;
  loginAt?: number;
  /** Legacy single-admin flag — kept only so cookies from before multi-user auth
   *  still deserialize as authenticated until they expire. New logins don't set it. */
  isAdmin?: boolean;
}

/** True if the session belongs to any signed-in user. Pure — safe to call from the proxy. */
export function isAuthenticated(session: AdminSession): boolean {
  return (!!session.userId && !!session.role) || session.isAdmin === true;
}

/** True if the session is an admin (new role flag, or a legacy admin cookie). */
export function isAdminSession(session: AdminSession): boolean {
  return session.role === 'admin' || session.isAdmin === true;
}

export function sessionOptions(): SessionOptions {
  return {
    password: env.sessionPassword(),
    cookieName: 'aimw_admin',
    cookieOptions: {
      httpOnly: true,
      sameSite: 'strict',
      secure: env.isProd(),
      path: '/',
      maxAge: 60 * 60 * 8, // 8 hours
    },
  };
}
