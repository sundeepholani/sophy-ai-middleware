import { resolveCliSession, revokeCliSession } from '@/lib/auth/cli-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const identity = await resolveCliSession(req.headers.get('authorization'));
  if (!identity) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
  await revokeCliSession(identity.sessionId, identity.userId);
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
