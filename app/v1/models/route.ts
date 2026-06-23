/**
 * OpenAI-compatible model listing. Each key maps to exactly one model, so this
 * returns that single model id.
 */
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
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

  return Response.json(
    {
      object: 'list',
      data: [{ id: key.model, object: 'model', created: 0, owned_by: 'sophy' }],
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
