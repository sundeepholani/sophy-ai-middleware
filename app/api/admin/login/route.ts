/**
 * Magic-link request endpoint (public).
 *
 * Takes an email, and IF it maps to an active user, emails a one-time sign-in
 * link. ALL account-specific work (lookup, token mint, send) runs AFTER the
 * response via after(), so the response is constant-time regardless of whether
 * the email exists — no enumeration via timing or error status. The link origin
 * is server-controlled (never request headers) to prevent link poisoning.
 */
import { after } from 'next/server';
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

/** Trusted client IP. Vercel sets x-real-ip; otherwise take the LAST (appended)
 *  x-forwarded-for hop — never the spoofable leftmost client-supplied value. */
function clientIp(req: Request): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return 'unknown';
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

  // Coarse abuse throttle on the trusted IP; per-email throttle is silent.
  if (!(await checkLoginRateLimit(`req-ip:${clientIp(req)}`))) {
    return Response.json({ error: 'too_many_attempts' }, { status: 429 });
  }
  const emailAllowed = await checkLoginRateLimit(`req:${email}`);

  // Server-controlled origin only (header-derived host is never trusted in prod).
  const origin =
    env.appOrigin() ??
    (env.isProd()
      ? null
      : `${req.headers.get('x-forwarded-proto') ?? 'http'}://${req.headers.get('host') ?? 'localhost:3000'}`);
  const next = typeof body.next === 'string' ? body.next : undefined;

  // Everything account-specific happens AFTER the response → constant-time, no
  // enumeration via latency or a send-failure 500.
  after(async () => {
    try {
      if (!emailAllowed || !origin) return;
      const user = (await findActiveUserByEmail(email)) ?? (await maybeBootstrapAdminForLogin(email));
      if (!user) return;
      const raw = await createLoginToken(user.id, user.email);
      const url = buildVerifyUrl(origin, raw, next);
      const sent = await sendEmail(user.email, 'Sign in to Sophy', signInEmailHtml(url));
      if (!sent && !env.isProd()) {
        console.info(`[auth] DEV magic link for ${user.email}: ${url}`);
      }
    } catch (err) {
      console.error('[auth] magic-link send failed', err);
    }
  });

  return Response.json(GENERIC);
}
