/** Public email OTP request; all identity-specific work follows the generic response. */
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import { z } from 'zod';
import { checkLoginRateLimit } from '@/lib/counters';
import { normalizeEmail } from '@/lib/auth/magic-link';
import { createOtpChallenge } from '@/lib/auth/otp';
import { authClientIp, isAuthJsonRequest, readAuthJson } from '@/lib/auth/request';
import { sendEmail } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
const input = z.object({ email: z.string().trim().email().max(254), next: z.string().max(2048).nullable().optional() });

function signInEmailHtml(code: string): string {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;color:#111">
    <h2>Continue to Sophy</h2>
    <p>Enter this code in the browser or terminal where you requested it:</p>
    <p style="font-size:32px;letter-spacing:8px;font-weight:700">${code}</p>
    <p>This code works once and expires in 10 minutes. Never share it with anyone.</p>
    <p>If you did not request this code, ignore this email.</p>
  </div>`;
}

export async function POST(req: Request): Promise<Response> {
  if (!isAuthJsonRequest(req)) return Response.json({ error: 'invalid_request' }, { status: 400, headers });
  const parsed = input.safeParse(await readAuthJson(req));
  if (!parsed.success) return Response.json({ error: 'invalid_email' }, { status: 400, headers });
  if (!(await checkLoginRateLimit(`req-ip:${authClientIp(req)}`))) {
    return Response.json({ error: 'too_many_attempts' }, { status: 429, headers });
  }
  const challengeId = randomUUID();
  const email = normalizeEmail(parsed.data.email);
  const next = parsed.data.next;
  after(async () => {
    try {
      const code = await createOtpChallenge(challengeId, email, next);
      if (code) await sendEmail(email, 'Your Sophy sign-in code', signInEmailHtml(code));
    } catch {
      // Provider/DB errors can contain addresses or request bodies. No secrets or
      // recipient data are ever logged, including in development environments.
      console.error('[auth] OTP delivery failed');
    }
  });
  return Response.json({ ok: true, challengeId }, { headers: { 'cache-control': 'no-store' } });
}
