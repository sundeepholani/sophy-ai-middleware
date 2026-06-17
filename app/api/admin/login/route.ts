import { getSession, verifyAdminCredentials } from '@/lib/auth/admin-session';
import { checkLoginRateLimit } from '@/lib/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  let body: { username?: string; password?: string };
  try {
    body = (await req.json()) as { username?: string; password?: string };
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const username = (body.username ?? '').trim();
  const password = body.password ?? '';
  if (!username || !password) {
    return Response.json({ error: 'missing_credentials' }, { status: 400 });
  }

  // Throttle brute-force attempts.
  const allowed = await checkLoginRateLimit(`login:${username}`);
  if (!allowed) {
    return Response.json({ error: 'too_many_attempts' }, { status: 429 });
  }

  const ok = await verifyAdminCredentials(username, password);
  if (!ok) {
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const session = await getSession();
  session.isAdmin = true;
  session.loginAt = Date.now();
  await session.save();

  return Response.json({ ok: true });
}
