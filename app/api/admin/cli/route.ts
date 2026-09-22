import { resolveCliSession, withCliIdentity } from '@/lib/auth/cli-session';
import { dispatchCliOperation, dispatchCliUpload, CliError } from '@/lib/admin/cli-operations';
import { cliResponse, cliErrorResponse, readCliBody } from '@/lib/admin/cli-http';
import { checkRateLimit } from '@/lib/counters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  try {
    // Cookie-only requests and inference API keys cannot authorize management.
    const identity = await resolveCliSession(req.headers.get('authorization'));
    if (!identity) throw new Error('unauthorized');
    const rate = await checkRateLimit(`cli:${identity.userId}`, 120);
    if (!rate.ok) return cliResponse({ error: { code: 'rate_limited', message: 'Too many management requests. Try again shortly.' } }, 429, { 'Retry-After': '60' });
    return await withCliIdentity(identity, async () => {
      const type = req.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      let data: unknown;
      if (type === 'multipart/form-data') {
        const bytes = await readCliBody(req, 4 * 1024 * 1024 + 64 * 1024);
        let form: FormData;
        try { form = await new Response(bytes as BodyInit, { headers: { 'Content-Type': req.headers.get('content-type')! } }).formData(); }
        catch { throw new CliError('invalid_request', 'Invalid multipart form.'); }
        data = await dispatchCliUpload(form);
      } else if (type === 'application/json') {
        const bytes = await readCliBody(req, 1024 * 1024);
        let body: unknown;
        try { body = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { throw new CliError('invalid_request', 'Invalid JSON body.'); }
        data = await dispatchCliOperation(body);
      } else {
        throw new CliError('unsupported_media_type', 'Use application/json or multipart/form-data.', 415);
      }
      return cliResponse({ ok: true, data: data ?? null });
    });
  } catch (error) {
    return cliErrorResponse(error);
  }
}
