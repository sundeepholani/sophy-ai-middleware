import { z } from 'zod';
import { consumeOtp } from '@/lib/auth/otp';
import { createCliSession } from '@/lib/auth/cli-session';
import { getSession } from '@/lib/auth/admin-session';
import { safeNextPath } from '@/lib/auth/safe-next';
import { authClientIp, isAuthJsonRequest, readAuthJson } from '@/lib/auth/request';
import { checkLoginRateLimit } from '@/lib/counters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const input = z.object({
  challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/), client: z.enum(['cli', 'web']),
  next: z.string().max(2048).nullable().optional(),
});
const headers = { 'cache-control': 'no-store' };

export async function POST(req: Request): Promise<Response> {
  if (!isAuthJsonRequest(req)) return Response.json({ error: 'invalid_request' }, { status: 400, headers });
  const parsed = input.safeParse(await readAuthJson(req));
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400, headers });
  if (!(await checkLoginRateLimit(`verify-ip:${authClientIp(req)}`))) {
    return Response.json({ error: 'too_many_attempts' }, { status: 429, headers });
  }
  const user = await consumeOtp(parsed.data.challengeId, parsed.data.code);
  if (!user) return Response.json({ error: 'invalid_or_expired_code' }, { status: 401, headers });
  if (parsed.data.client === 'cli') {
    return Response.json({ ok: true, ...await createCliSession(user.id), user }, { headers });
  }
  const session = await getSession();
  session.userId = user.id;
  session.role = undefined;
  session.email = undefined;
  session.isAdmin = undefined;
  session.loginAt = Date.now();
  session.sealedAt = Date.now();
  await session.save();
  return Response.json({ ok: true, next: safeNextPath(parsed.data.next) }, { headers });
}
