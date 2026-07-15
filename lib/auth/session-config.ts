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
  /** When the cookie was last (re-)sealed — drives the proxy's renewal throttle. */
  sealedAt?: number;
  /** Legacy single-admin flag — kept only so cookies from before multi-user auth
   *  still deserialize as authenticated until they expire. New logins don't set it. */
  isAdmin?: boolean;
}

/**
 * True when the cookie identifies a user. Project roles are deliberately not
 * trusted here; every project request re-loads its membership from Postgres.
 */
export function isAuthenticated(session: AdminSession): boolean {
  return !!session.userId;
}

/** Legacy UI helper only. Never use this for project authorization. */
export function isAdminSession(session: AdminSession): boolean {
  return !!session.userId && session.role === 'admin';
}

/**
 * Sliding session window: an operator stays signed in this long after their
 * LAST console request, not after login — the proxy re-seals the cookie on
 * every authenticated request, restarting the window. Security still rests on
 * the per-request role/status re-check in lib/auth/viewer.ts (deactivating a
 * user locks them out immediately, cookie or not).
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 5; // 5 days

/**
 * Renewal throttle: the proxy re-seals only when the current seal is older than
 * this. Two reasons: (1) no Set-Cookie on every response; (2) a response that
 * was in flight when the operator signed out can carry a fresh cookie and
 * silently resurrect the destroyed session — throttling shrinks that race from
 * "every response" to "a response that happened to cross a renewal boundary".
 * Worst case the session expires SESSION_RENEW_AFTER_SECONDS early, never late.
 */
export const SESSION_RENEW_AFTER_SECONDS = 60 * 60; // 1 hour

export function sessionOptions(): SessionOptions {
  return {
    password: env.sessionPassword(),
    cookieName: 'aimw_admin',
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'strict',
      secure: env.isProd(),
      path: '/',
      // maxAge intentionally omitted: iron-session derives it as ttl - 60s,
      // so the sealed data always outlives the browser cookie.
    },
  };
}
