/**
 * Admin session config shared by route handlers (admin-session.ts) and the
 * edge middleware. Kept free of `next/headers`/bcrypt so it is safe to import
 * from middleware.
 */
import type { SessionOptions } from 'iron-session';
import { env } from '@/lib/env';

export interface AdminSession {
  isAdmin?: boolean;
  loginAt?: number;
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
