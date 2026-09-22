import { ZodError } from 'zod';
import { CliError } from '@/lib/admin/cli-operations';

export function cliResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

const knownErrors: Record<string, [number, string]> = {
  unauthorized: [401, 'Sign in with sophy login.'],
  forbidden: [403, 'Your current project role or resource ownership does not allow this action.'],
  not_found: [404, 'The resource is unavailable in your project or access scope.'],
  gateway_not_ready: [409, 'Connect a healthy project Gateway credential first.'],
  gateway_invalid: [400, 'The Gateway credential could not be validated.'],
  gateway_in_use: [409, 'This Gateway credential is already in use by another project.'],
  last_project_admin: [409, 'The project must retain an active Admin.'],
  already_member: [409, 'This user is already a project member.'],
};

// Route handlers do not receive Server Actions' automatic error masking. Only
// known business messages may pass through; never return driver SQL or secrets.
const safeMessages = new Set([
  'Owner user not found', 'Knowledgebase not found', 'Document not found',
  'Only an active key can be rotated', 'Key not found or not active', 'Key is not active',
  'Challenger must differ from the current model', 'An eval is already running for this key',
  'This model type cannot be served by a Sophy key', 'Choose a batch transcription model for uploaded audio',
  'Choose a transcript processor model when a transcription key has a system prompt.',
  'Transcript processor must be a language model.',
  'Eval is only available for language models',
  'Choose a file to upload',
  'Unsupported file type — upload text, Markdown, CSV, JSON, PDF, or Word (.docx)',
  'File is too large (max 4 MB)',
]);

export function cliErrorResponse(error: unknown): Response {
  if (error instanceof CliError) return cliResponse({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof ZodError) {
    // Field paths are useful; issue values/messages can contain supplied secrets.
    const fields = [...new Set(error.issues.map((issue) => issue.path.join('.') || 'request'))];
    return cliResponse({ error: { code: 'invalid_request', message: `Invalid fields: ${fields.join(', ')}.` } }, 400);
  }
  const message = error instanceof Error ? error.message : '';
  if (Object.hasOwn(knownErrors, message)) {
    const [status, safe] = knownErrors[message];
    return cliResponse({ error: { code: message, message: safe } }, status);
  }
  if (safeMessages.has(message)) return cliResponse({ error: { code: 'invalid_request', message } }, 400);
  if (message.startsWith('Output schema is not a valid JSON Schema:')) {
    return cliResponse({ error: { code: 'invalid_schema', message: 'Output schema is not a valid JSON Schema.' } }, 400);
  }
  if (/^This knowledgebase is attached to \d+ key\(s\)\. Detach it from them first\.$/.test(message)) {
    return cliResponse({ error: { code: 'knowledgebase_in_use', message } }, 409);
  }
  return cliResponse({ error: { code: 'internal_error', message: 'The operation could not be completed. Try again later.' } }, 500);
}

/** Enforce size even for chunked requests with no Content-Length header. */
export async function readCliBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (Number(req.headers.get('content-length')) > maxBytes) throw new CliError('payload_too_large', 'Request body is too large.', 413);
  const reader = req.body?.getReader();
  if (!reader) throw new CliError('invalid_request', 'A request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new CliError('payload_too_large', 'Request body is too large.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
