import { getSession } from '@/lib/auth/admin-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const session = await getSession();
  session.destroy();
  return Response.json({ ok: true });
}
