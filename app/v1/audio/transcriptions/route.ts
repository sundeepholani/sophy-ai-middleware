/**
 * OpenAI-compatible buffered speech-to-text endpoint.
 *
 * The authenticated key owns the transcription model. An optional system
 * prompt is applied in a second, explicitly configured language-model step so
 * instructions such as summarization or redaction run in the appropriate model
 * stage.
 */
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
import { checkRateLimit, costUsedThisMonth } from '@/lib/counters';
import { openAiError } from '@/lib/http/openai';
import {
  handleTranscription,
  MAX_MULTIPART_BODY_BYTES,
  parseTranscriptionForm,
  processorCapability,
  shouldProcessTranscript,
  transcriptionCapability,
} from '@/lib/gateway/transcriptions';
import {
  projectGatewayUnavailableResponse,
  resolveProjectGateway,
} from '@/lib/gateway/project-provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

type MultipartFormReadResult =
  | { ok: true; form: FormData }
  | { ok: false; tooLarge: boolean };

/**
 * Read the request body with a hard byte ceiling before asking the platform to
 * parse multipart data. Content-Length is optional (and cannot be trusted on
 * chunked requests), so the streaming count is the authoritative limit.
 */
async function readMultipartForm(
  req: Request,
  contentType: string,
): Promise<MultipartFormReadResult> {
  const reader = req.body?.getReader();
  if (!reader) return { ok: false, tooLarge: false };

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MULTIPART_BODY_BYTES) {
        // Stop accepting bytes as soon as the hard limit is crossed. Cancellation
        // is best-effort because a disconnected client can make it reject.
        await reader.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const form = await new Response(body, {
      headers: { 'content-type': contentType },
    }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

export async function POST(req: Request): Promise<Response> {
  // 1) Authenticate the key (which carries the complete STT configuration).
  const token = bearerFromHeader(req.headers.get('authorization'));
  if (!token) {
    return openAiError(401, 'authentication_error', 'Missing API key.', {
      code: 'missing_api_key',
    });
  }
  const key = await verifyKey(token);
  if (!key) {
    return openAiError(401, 'authentication_error', 'Invalid API key.', {
      code: 'invalid_api_key',
    });
  }

  let gateway;
  try {
    gateway = await resolveProjectGateway(key.projectId);
  } catch (error) {
    const unavailable = projectGatewayUnavailableResponse(error);
    if (unavailable) return unavailable;
    console.error('[gateway] project provider resolution failed', { projectId: key.projectId });
    return openAiError(503, 'api_error', 'This project is temporarily unable to make AI requests.', {
      code: 'project_gateway_unavailable',
    });
  }

  // 2) Reject obviously incompatible/oversized requests before buffering them.
  // Preserve the original header for parsing: multipart boundary values are
  // case-sensitive even though the media type itself is not.
  const contentType = req.headers.get('content-type') ?? '';
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'multipart/form-data') {
    return openAiError(
      400,
      'invalid_request_error',
      'Request body must use multipart/form-data.',
      { code: 'invalid_content_type' },
    );
  }
  const contentLengthHeader = req.headers.get('content-length');
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (
    contentLength !== null &&
    Number.isFinite(contentLength) &&
    contentLength > MAX_MULTIPART_BODY_BYTES
  ) {
    return openAiError(
      413,
      'invalid_request_error',
      'The uploaded audio file must not exceed 4 MiB.',
      { code: 'file_too_large', param: 'file' },
    );
  }

  // 3) Prove the key is suitable for this surface before admitting or reading
  // the upload.
  if ((await transcriptionCapability(key.model)) === 'not_transcription') {
    return openAiError(
      400,
      'invalid_request_error',
      "This key's model does not support uploaded-audio transcription.",
      { code: 'model_not_transcription' },
    );
  }

  const needsProcessing = shouldProcessTranscript(key.systemPrompt);
  const processorModel = key.params.transcriptProcessorModel?.trim() || null;
  if (needsProcessing && !processorModel) {
    return openAiError(
      400,
      'invalid_request_error',
      'This transcription key has a system prompt but no transcript processor model.',
      { code: 'transcript_processor_required' },
    );
  }
  if (
    needsProcessing &&
    processorModel &&
    (await processorCapability(processorModel)) === 'not_language'
  ) {
    return openAiError(
      400,
      'invalid_request_error',
      "This key's transcript processor is not a language model.",
      { code: 'processor_model_not_language' },
    );
  }

  // 4) Admit the request before buffering client-controlled audio. This keeps
  // rate-limited and over-budget callers from consuming upload memory.
  const rateLimit = await checkRateLimit(key.id, key.rpmLimit);
  if (!rateLimit.ok) {
    const retryAfter = rateLimit.reset
      ? Math.max(1, Math.ceil((rateLimit.reset - Date.now()) / 1000))
      : 60;
    return openAiError(429, 'rate_limit_error', 'Rate limit exceeded.', {
      code: 'rate_limit_exceeded',
      headers: { 'retry-after': String(retryAfter) },
    });
  }
  let monthlyCostUsedUsd: number | null = null;
  if (key.monthlyCostCapUsd != null) {
    const used = await costUsedThisMonth(key.id);
    monthlyCostUsedUsd = used;
    if (used >= key.monthlyCostCapUsd) {
      return openAiError(402, 'insufficient_quota', 'Monthly cost budget exceeded.', {
        code: 'quota_exceeded',
      });
    }
  }

  // 5) Buffer under an enforced streaming ceiling, then validate the form.
  const multipart = await readMultipartForm(req, contentType);
  if (!multipart.ok) {
    if (multipart.tooLarge) {
      return openAiError(
        413,
        'invalid_request_error',
        'The uploaded audio file must not exceed 4 MiB.',
        { code: 'file_too_large', param: 'file' },
      );
    }
    return openAiError(
      400,
      'invalid_request_error',
      'Request body must be valid multipart/form-data.',
      { code: 'invalid_multipart_form' },
    );
  }

  const parsed = await parseTranscriptionForm(multipart.form, key.model);
  if (!parsed.ok) {
    return openAiError(parsed.status, 'invalid_request_error', parsed.message, {
      code: parsed.code,
      param: parsed.param,
    });
  }

  // 6) Transcribe, optionally process, account, log safe text (never audio), and respond.
  return handleTranscription(
    {
      keyId: key.id,
      gateway,
      model: key.model,
      systemPrompt: key.systemPrompt,
      params: key.params,
      monthlyCostCapUsd: key.monthlyCostCapUsd,
      monthlyCostUsedUsd,
      logContent: key.logContent,
    },
    parsed.value,
  );
}
