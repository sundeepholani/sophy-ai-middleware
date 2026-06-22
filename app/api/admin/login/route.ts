/**
 * Magic-link request endpoint (public).
 *
 * Takes an email, and IF it maps to an active user, emails a one-time sign-in
 * link. Always returns a generic success so it can't be used to enumerate users.
 * In non-prod with email unconfigured, the link is logged/returned so local dev
 * works without ZeptoMail.
 */
import { checkLoginRateLimit } from '@/lib/counters';
import {
  normalizeEmail,
  findActiveUserByEmail,
  createLoginToken,
  buildVerifyUrl,
} from '@/lib/auth/magic-link';
import { maybeBootstrapAdminForLogin } from '@/db/seed-admin';
import { sendEmail } from '@/lib/email/send';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC = { ok: true as const };

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0] : '').trim() || 'unknown';
}

function requestOrigin(req: Request): string | null {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host) return null;
  const proto = req.headers.get('x-forwarded-proto') ?? (env.isProd() ? 'https' : 'http');
  return `${proto}://${host}`;
}

function signInEmailHtml(url: string): string {
  return `
  <div style="font-family:system-ui,sans-serif;max-width:480px;color:#111">
    <h2 style="margin:0 0 8px">Sign in to Sophy</h2>
    <p style="font-size:14px;margin:0 0 16px">Click the button below to sign in. This link works once and expires in 15 minutes.</p>
    <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Sign in</a></p>
    <p style="font-size:12px;color:#888;margin-top:16px">If you didn't request this, you can ignore this email.</p>
  </div>`;
}

export async function POST(req: Request): Promise<Response> {
  let body: { email?: string; next?: string };
  try {
    body = (await req.json()) as { email?: string; next?: string };
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const email = normalizeEmail(body.email ?? '');
  if (!email || !EMAIL_RE.test(email)) {
    return Response.json({ error: 'invalid_email' }, { status: 400 });
  }

  // Coarse abuse throttle on IP; per-email throttle is silent (no enumeration).
  if (!(await checkLoginRateLimit(`req-ip:${clientIp(req)}`))) {
    return Response.json({ error: 'too_many_attempts' }, { status: 429 });
  }
  const emailAllowed = await checkLoginRateLimit(`req:${email}`);

  const origin = requestOrigin(req);
  if (emailAllowed && origin) {
    const user =
      (await findActiveUserByEmail(email)) ?? (await maybeBootstrapAdminForLogin(email));
    if (user) {
      const raw = await createLoginToken(user.id, user.email);
      const url = buildVerifyUrl(origin, raw, body.next);
      const sent = await sendEmail(user.email, 'Sign in to Sophy', signInEmailHtml(url));
      if (!sent && !env.isProd()) {
        console.info(`[auth] DEV magic link for ${user.email}: ${url}`);
        return Response.json({ ...GENERIC, devLink: url });
      }
    }
  }

  return Response.json(GENERIC);
}
