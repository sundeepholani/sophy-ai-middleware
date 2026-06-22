/**
 * Admin auth gate (Next.js 16 Routing Proxy — formerly "middleware").
 *
 * Guards ONLY the operator surface (/admin + /api/admin). The client proxy
 * (/api/v1/*) is deliberately NOT matched — it authenticates with our `mw_*`
 * keys and must never accept the admin cookie.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getIronSession } from 'iron-session';
import { sessionOptions, isAuthenticated, type AdminSession } from '@/lib/auth/session-config';

// Public (unauthenticated) console paths: the email-link request, and the verify
// landing/confirm (which establishes the session itself).
const PUBLIC_ADMIN_PATHS = ['/admin/login', '/api/admin/login', '/admin/auth/verify'];

export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC_ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  const res = NextResponse.next();
  const session = await getIronSession<AdminSession>(req, res, sessionOptions());

  if (isPublic || isAuthenticated(session)) return res;

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
