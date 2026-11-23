/** Public email OTP request; all identity-specific work follows the generic response. */
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import { z } from 'zod';
import { checkLoginRateLimit } from '@/lib/counters';
import { normalizeEmail } from '@/lib/auth/magic-link';
import { createOtpChallenge } from '@/lib/auth/otp';
import { authClientIp, isAuthJsonRequest, readAuthJson } from '@/lib/auth/request';
import { signInEmail } from '@/lib/email/auth';
import { sendEmail } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
const input = z.object({ email: z.string().trim().email().max(254), next: z.string().max(2048).nullable().optional() });

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
      if (code) await sendEmail(email, signInEmail(code));
    } catch {
      // Provider/DB errors can contain addresses or request bodies. No secrets or
      // recipient data are ever logged, including in development environments.
      console.error('[auth] OTP delivery failed');
    }
  });
  return Response.json({ ok: true, challengeId }, { headers: { 'cache-control': 'no-store' } });
}
