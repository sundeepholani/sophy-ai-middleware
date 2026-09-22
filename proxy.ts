/**
 * Admin auth gate (Next.js 16 Routing Proxy — formerly "middleware").
 *
 * Guards ONLY the operator surface (/admin + /api/admin). The client proxy
 * (/api/v1/*) is deliberately NOT matched — it authenticates with our `mw_*`
 * keys and must never accept the admin cookie.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getIronSession } from 'iron-session';
import {
  sessionOptions,
  isAuthenticated,
  SESSION_RENEW_AFTER_SECONDS,
  type AdminSession,
} from '@/lib/auth/session-config';

// Public OTP request/verification and invitation landing pages.
const PUBLIC_ADMIN_PATHS = [
  '/admin/login',
  '/api/admin/login',
  '/admin/auth/verify',
  '/admin/invitations/accept',
];

export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  // These handlers require their own revocable CLI bearer token. A browser
  // cookie cannot authorize them, and the token cannot authorize browser pages.
  if (pathname === '/api/admin/cli' || pathname.startsWith('/api/admin/cli/')) {
    return NextResponse.next();
  }
  const isPublic = PUBLIC_ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  const res = NextResponse.next();
  const session = await getIronSession<AdminSession>(req, res, sessionOptions());

  if (isAuthenticated(session)) {
    // Sliding expiry: re-seal so the session lives SESSION_TTL_SECONDS past the
    // operator's last live action (page loads, server actions, /api/admin
    // fetches all pass through here) — throttled to once per renewal window,
    // and never on the logout request, whose whole purpose is to destroy the
    // cookie its own response carries.
    const sealAge = Date.now() - (session.sealedAt ?? 0);
    if (pathname !== '/api/admin/logout' && sealAge > SESSION_RENEW_AFTER_SECONDS * 1000) {
      session.sealedAt = Date.now();
      await session.save();
    }
    return res;
  }
  if (isPublic) return res;

  if (pathname.startsWith('/api/admin')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/admin/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
