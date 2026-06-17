/**
 * OpenAI-compatible model listing. Returns the logical ROUTE NAMES the calling
 * key is scoped to — never the underlying provider models.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { routes } from '@/db/schema';
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
import { keyAllowsRoute } from '@/lib/routing/resolve';
import { openAiError } from '@/lib/http/openai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'bom1';

export async function GET(req: Request): Promise<Response> {
  const token = bearerFromHeader(req.headers.get('authorization'));
  if (!token) {
    return openAiError(401, 'authentication_error', 'Missing API key.', { code: 'missing_api_key' });
  }
  const key = await verifyKey(token);
  if (!key) {
    return openAiError(401, 'authentication_error', 'Invalid API key.', { code: 'invalid_api_key' });
  }

  const rows = await getDb()
    .select({ name: routes.name, createdAt: routes.createdAt })
    .from(routes)
    .where(eq(routes.clientId, key.clientId));

  const data = rows
    .filter((r) => keyAllowsRoute(key.scopes, r.name))
    .map((r) => ({
      id: r.name,
      object: 'model' as const,
      created: Math.floor(r.createdAt.getTime() / 1000),
      owned_by: 'ai-middleware',
    }));

  return Response.json({ object: 'list', data }, { headers: { 'cache-control': 'no-store' } });
}
