/**
 * Magic-link request endpoint (public).
 *
 * Takes an email and sends either an existing-identity login token or a verified
 * signup intent. All account-specific work runs after the generic response, so
 * callers cannot distinguish the two paths. Unknown emails are not persisted as
 * identities until the recipient explicitly verifies the link.
 */
import { after } from 'next/server';
import { checkLoginRateLimit } from '@/lib/counters';
import {
  normalizeEmail,
  createAuthenticationToken,
  buildVerifyUrl,
} from '@/lib/auth/magic-link';
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
    <h2 style="margin:0 0 8px">Continue to Sophy</h2>
    <p style="font-size:14px;margin:0 0 8px">Click the button below to sign in or create your account. This link works once and expires in 15 minutes.</p>
    <p style="font-size:13px;margin:0 0 16px;color:#555">If you are new to Sophy, verification creates a renameable My Project and makes you its Project Admin.</p>
    <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Continue to Sophy</a></p>
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
      const { raw } = await createAuthenticationToken(email);
      const url = buildVerifyUrl(origin, raw, next);
      const sent = await sendEmail(email, 'Continue to Sophy', signInEmailHtml(url));
      if (!sent && !env.isProd()) {
        console.info(`[auth] DEV magic link for ${email}: ${url}`);
      }
    } catch (err) {
      console.error('[auth] magic-link send failed', err);
    }
  });

  return Response.json(GENERIC);
}
