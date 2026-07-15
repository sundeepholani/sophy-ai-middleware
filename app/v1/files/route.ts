/**
 * File upload endpoint. Clients POST multipart/form-data with a `file` field
 * and reference the returned URL as a content part in chat messages. Bounded by
 * a content-type allowlist and a size cap; each upload is bound to the key.
 *
 * For files larger than the cap, use a direct-to-Blob client upload flow (v2).
 */
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
import {
  uploadClientFile,
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
} from '@/lib/files/blob';
import { openAiError } from '@/lib/http/openai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'bom1';

export async function POST(req: Request): Promise<Response> {
  const token = bearerFromHeader(req.headers.get('authorization'));
  if (!token) {
    return openAiError(401, 'authentication_error', 'Missing API key.', { code: 'missing_api_key' });
  }
  const key = await verifyKey(token);
  if (!key) {
    return openAiError(401, 'authentication_error', 'Invalid API key.', { code: 'invalid_api_key' });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return openAiError(400, 'invalid_request_error', 'Expected multipart/form-data with a "file" field.');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return openAiError(400, 'invalid_request_error', 'Missing "file" field.', { param: 'file' });
  }

  const contentType = file.type || 'application/octet-stream';
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return openAiError(400, 'invalid_request_error', `Unsupported content type: ${contentType}.`, {
      param: 'file',
      code: 'unsupported_file_type',
    });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return openAiError(413, 'invalid_request_error', `File exceeds the ${MAX_UPLOAD_BYTES} byte limit.`, {
      param: 'file',
      code: 'file_too_large',
    });
  }

  try {
    const data = await file.arrayBuffer();
    const uploaded = await uploadClientFile({
      projectId: key.projectId,
      keyId: key.id,
      filename: file.name || 'upload',
      contentType,
      data,
    });
    return Response.json(uploaded, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[files] upload failed', err);
    return openAiError(502, 'api_error', 'File upload failed.', { code: 'upload_failed' });
  }
}
