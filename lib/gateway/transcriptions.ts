/**
 * Buffered audio transcription through the project-scoped Vercel AI Gateway.
 *
 * A transcription model converts the clip to text. When the key has a system
 * prompt, a separate language model then processes that raw transcript. This
 * separation is intentional: speech-recognition prompts can guide spelling and
 * terminology, but they cannot reliably summarize, translate, redact, or
 * extract structured information.
 */
import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { transcribe } from 'ai-v7';
import type { KeyParams } from '@/db/schema';
import { costUsedThisMonth } from '@/lib/counters';
import { openAiError, type AudioTranscriptionResponse } from '@/lib/http/openai';
import {
  extractGatewayCost,
  extractGatewayRequestId,
  normalizeUsage,
  recordTranscriptionLog,
  recordUsage,
  recordUsageBatch,
  ZERO_USAGE,
  type NormalizedUsage,
  type RecordUsageInput,
} from '@/lib/usage/record';
import { buildSystem, providerOf } from '@/lib/gateway/call';
import {
  catalogCapability,
  languageCapability,
  modelSupportsBatchTranscription,
} from '@/lib/gateway/models';
import {
  normalizeProjectGatewayError,
  type ProjectGatewaySnapshot,
} from '@/lib/gateway/project-provider';
import { safeGatewayErrorMessage, upstreamErrorResponse } from '@/lib/gateway/upstream-error';

export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
/** Keep multipart overhead below the deployment platform's request-body limit. */
export const MAX_MULTIPART_BODY_BYTES = 4_500_000;
const UPSTREAM_TIMEOUT_MS = 300_000;

export type SupportedAudioFormat =
  | 'flac'
  | 'mp3'
  | 'mp4'
  | 'ogg'
  | 'wav'
  | 'webm';

export interface DetectedAudioFormat {
  format: SupportedAudioFormat;
  mediaType: string;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return (
    bytes.length >= offset + signature.length &&
    signature.every((value, index) => bytes[offset + index] === value)
  );
}

function hasMp3Frame(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 2 || bytes[offset] !== 0xff) return false;
  const second = bytes[offset + 1];
  // 11-bit sync, a non-reserved MPEG version, and a real audio layer. This
  // excludes AAC ADTS frames, which also begin with 0xff.
  return (
    (second & 0xe0) === 0xe0 &&
    (second & 0x18) !== 0x08 &&
    (second & 0x06) !== 0
  );
}

function mp3AudioOffset(bytes: Uint8Array): number {
  if (!startsWith(bytes, [0x49, 0x44, 0x33])) return 0; // ID3
  if (bytes.length < 10) return -1;
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  const footerBytes = (bytes[5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footerBytes;
}

/**
 * Detect supported audio from file bytes rather than trusting a caller-supplied
 * filename or MIME type. This prevents renamed text/images from reaching a paid
 * model call while allowing clients whose operating system reports a generic
 * MIME type.
 */
export function detectAudioFormat(bytes: Uint8Array): DetectedAudioFormat | null {
  if (
    bytes.length >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)
  ) {
    return { format: 'wav', mediaType: 'audio/wav' };
  }
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) {
    return { format: 'flac', mediaType: 'audio/flac' };
  }
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return { format: 'ogg', mediaType: 'audio/ogg' };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { format: 'webm', mediaType: 'audio/webm' };
  }
  // ISO base-media files (MP4/M4A) carry an `ftyp` box after its 4-byte size.
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    return { format: 'mp4', mediaType: 'audio/mp4' };
  }
  const mp3Offset = mp3AudioOffset(bytes);
  if (mp3Offset >= 0 && hasMp3Frame(bytes, mp3Offset)) {
    return { format: 'mp3', mediaType: 'audio/mpeg' };
  }
  return null;
}

export interface ParsedTranscriptionRequest {
  file: {
    name: string;
    bytes: Uint8Array;
    size: number;
    mediaType: string;
    format: SupportedAudioFormat;
  };
  language: string | null;
  providerOptions: Record<string, Record<string, unknown>>;
}

export type ParseTranscriptionResult =
  | { ok: true; value: ParsedTranscriptionRequest }
  | { ok: false; status: number; message: string; code: string; param?: string };

const UNSUPPORTED_OPTIONS = [
  'prompt',
  'temperature',
  'logprobs',
  'stream',
  'timestamp_granularities',
  'timestamp_granularities[]',
  'diarization',
  'include',
  'chunking_strategy',
  'known_speaker_names',
  'known_speaker_references',
] as const;

function singleTextField(
  form: FormData,
  name: string,
): { ok: true; value: string | null } | { ok: false } {
  const values = form.getAll(name);
  if (values.length === 0) return { ok: true, value: null };
  if (values.length !== 1 || typeof values[0] !== 'string') return { ok: false };
  return { ok: true, value: values[0] };
}

/**
 * Validate and normalize an OpenAI-style multipart transcription request. The
 * client `model` field is accepted but intentionally ignored: as on Sophy's
 * other endpoints, the authenticated key owns the model.
 */
export async function parseTranscriptionForm(
  form: FormData,
  keyModel: string,
): Promise<ParseTranscriptionResult> {
  for (const option of UNSUPPORTED_OPTIONS) {
    if (form.has(option)) {
      return {
        ok: false,
        status: 400,
        message: `${option} is not supported by this transcription endpoint.`,
        code: 'unsupported_transcription_option',
        param: option,
      };
    }
  }

  const responseFormat = singleTextField(form, 'response_format');
  if (!responseFormat.ok || (responseFormat.value !== null && responseFormat.value !== 'json')) {
    return {
      ok: false,
      status: 400,
      message: 'response_format must be "json" when provided.',
      code: 'unsupported_response_format',
      param: 'response_format',
    };
  }

  const languageField = singleTextField(form, 'language');
  if (
    !languageField.ok ||
    (languageField.value !== null && !/^[a-z]{2}$/i.test(languageField.value))
  ) {
    return {
      ok: false,
      status: 400,
      message: 'language must be a two-letter ISO-639-1 code such as "en".',
      code: 'invalid_language',
      param: 'language',
    };
  }
  const language = languageField.value?.toLowerCase() ?? null;

  const fileValues = form.getAll('file');
  if (fileValues.length === 0) {
    return {
      ok: false,
      status: 400,
      message: 'Missing required parameter: file.',
      code: 'missing_file',
      param: 'file',
    };
  }
  const file = fileValues[0];
  const name =
    typeof file === 'object' &&
    file !== null &&
    'name' in file &&
    typeof (file as { name?: unknown }).name === 'string'
      ? (file as File).name
      : null;
  if (fileValues.length !== 1 || !(file instanceof Blob) || name === null) {
    return {
      ok: false,
      status: 400,
      message: 'file must contain exactly one uploaded audio file.',
      code: 'invalid_file',
      param: 'file',
    };
  }
  if (file.size === 0) {
    return {
      ok: false,
      status: 400,
      message: 'The uploaded audio file must not be empty.',
      code: 'empty_file',
      param: 'file',
    };
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `The uploaded audio file must not exceed ${MAX_AUDIO_BYTES} bytes (4 MiB).`,
      code: 'file_too_large',
      param: 'file',
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectAudioFormat(bytes);
  if (!detected) {
    return {
      ok: false,
      status: 400,
      message: 'Unsupported audio format. Use FLAC, MP3, MP4/M4A, OGG, WAV, or WebM.',
      code: 'unsupported_audio_format',
      param: 'file',
    };
  }

  const providerOptions: Record<string, Record<string, unknown>> = {};
  if (language) providerOptions[providerOf(keyModel)] = { language };
  return {
    ok: true,
    value: {
      file: {
        name,
        bytes,
        size: file.size,
        mediaType: detected.mediaType,
        format: detected.format,
      },
      language,
      providerOptions,
    },
  };
}

export { modelSupportsBatchTranscription };

export async function transcriptionCapability(
  model: string,
): Promise<'transcription' | 'not_transcription' | 'unknown'> {
  const result = await catalogCapability(model, modelSupportsBatchTranscription);
  return result === 'supported'
    ? 'transcription'
    : result === 'unsupported'
      ? 'not_transcription'
      : 'unknown';
}

/**
 * The transcript processor is a language model, so this is languageCapability
 * under the name this surface uses for it. Kept as a named export: the route
 * imports it by this name, and so does its test's mock.
 */
export { languageCapability as processorCapability };

export function shouldProcessTranscript(systemPrompt: string | null): boolean {
  return !!systemPrompt?.trim();
}

/**
 * Keeps the spoken transcript in the untrusted user-data position. It is never
 * concatenated into the operator's system prompt, so a spoken instruction such
 * as "ignore the system prompt" cannot promote itself to operator policy.
 */
export function transcriptProcessorPrompt(
  systemPrompt: string,
  transcript: string,
): { system: string; prompt: string } {
  return {
    system: buildSystem(systemPrompt) ?? systemPrompt,
    prompt: transcript,
  };
}

export function toAudioTranscriptionResponse(input: {
  transcript: string;
  processedText?: string;
  language?: string;
  durationInSeconds?: number;
}): AudioTranscriptionResponse {
  const processed = input.processedText !== undefined;
  return {
    text: input.processedText ?? input.transcript,
    // A processor prompt may enforce redaction or another disclosure policy.
    // Returning the raw text alongside the processed output would give callers
    // a trivial way around that centrally managed policy.
    ...(!processed ? { transcript: input.transcript } : {}),
    processed,
    ...(input.language ? { language: input.language } : {}),
    ...(input.durationInSeconds !== undefined ? { duration: input.durationInSeconds } : {}),
  };
}

export interface TranscriptionCallContext {
  keyId: string;
  gateway: ProjectGatewaySnapshot;
  /** Primary key model; must be a batch transcription model. */
  model: string;
  systemPrompt: string | null;
  params: KeyParams;
  monthlyCostCapUsd: number | null;
  /** Spend observed by the route before it admitted this request. */
  monthlyCostUsedUsd: number | null;
  logContent: boolean;
}

/**
 * Execute one client request. The primary proxy row records the STT model call;
 * an optional transcript_processor row records the language-model component.
 * Client analytics count only the proxy row as a request while summing the
 * tokens/cost from both rows. The proxy row carries the terminal HTTP outcome;
 * component rows describe only model stages that were actually attempted.
 */
export async function handleTranscription(
  ctx: TranscriptionCallContext,
  parsed: ParsedTranscriptionRequest,
): Promise<Response> {
  const startedAt = Date.now();
  const eventId = randomUUID();
  const processingRequired = shouldProcessTranscript(ctx.systemPrompt);
  const processorModel = processingRequired
    ? ctx.params.transcriptProcessorModel?.trim() || null
    : null;
  const processorEventId = processorModel ? randomUUID() : null;
  // Defensive invariant: the route and admin save path both enforce this, but
  // never let a future internal caller silently bypass required processing.
  if (processingRequired && !processorModel) {
    return openAiError(
      400,
      'invalid_request_error',
      'This transcription key has a system prompt but no transcript processor model.',
      { code: 'transcript_processor_required' },
    );
  }
  let transcript: string | null = null;
  let transcriptionCost: number | null = null;
  let transcriptionRequestId: string | null = null;

  const log = (status: 'ok' | 'error', response: string | null) =>
    ctx.logContent
      ? recordTranscriptionLog({
          id: eventId,
          projectId: ctx.gateway.projectId,
          keyId: ctx.keyId,
          file: {
            name: parsed.file.name,
            mediaType: parsed.file.mediaType,
            bytes: parsed.file.size,
          },
          languageHint: parsed.language,
          transcript,
          processorModel,
          systemPrompt: ctx.systemPrompt,
          response,
          status,
        })
      : Promise.resolve();

  const primaryUsageRow = (input: {
    status: 'ok' | 'error';
    costUsd?: number | null;
    errorMessage?: string | null;
  }): RecordUsageInput => ({
    id: eventId,
    projectId: ctx.gateway.projectId,
    gatewayCredentialId: ctx.gateway.gatewayCredentialId,
    keyId: ctx.keyId,
    source: 'proxy',
    provider: providerOf(ctx.model),
    model: ctx.model,
    usage: { ...ZERO_USAGE },
    costUsd: input.costUsd,
    latencyMs: Date.now() - startedAt,
    status: input.status,
    responseKind: 'transcription',
    gatewayRequestId: transcriptionRequestId,
    errorMessage: input.errorMessage,
  });

  const processorUsageRow = (input: {
    status: 'ok' | 'error';
    usage?: NormalizedUsage;
    costUsd?: number | null;
    latencyMs?: number | null;
    gatewayRequestId?: string | null;
    errorMessage?: string | null;
  }): RecordUsageInput | null => {
    if (!processorModel || !processorEventId) return null;
    return {
      id: processorEventId,
      projectId: ctx.gateway.projectId,
      gatewayCredentialId: ctx.gateway.gatewayCredentialId,
      keyId: ctx.keyId,
      source: 'transcript_processor',
      provider: providerOf(processorModel),
      model: processorModel,
      usage: input.usage ?? { ...ZERO_USAGE },
      costUsd: input.costUsd,
      latencyMs: input.latencyMs,
      status: input.status,
      responseKind: 'transcription',
      gatewayRequestId: input.gatewayRequestId,
      errorMessage: input.errorMessage,
    };
  };

  let transcriptionResult: Awaited<ReturnType<typeof transcribe>>;
  try {
    transcriptionResult = await transcribe({
      model: ctx.gateway.transcriptionGateway.transcriptionModel(ctx.model),
      audio: parsed.file.bytes,
      providerOptions: parsed.providerOptions as never,
      abortSignal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    transcript = transcriptionResult.text;
    transcriptionCost = extractGatewayCost(transcriptionResult.providerMetadata);
    transcriptionRequestId = extractGatewayRequestId(transcriptionResult.providerMetadata);
    if (transcriptionResult.warnings.length > 0) {
      console.warn('[transcription] provider warnings', {
        model: ctx.model,
        warnings: transcriptionResult.warnings,
      });
    }
  } catch (error) {
    const normalizedError = await normalizeProjectGatewayError(ctx.gateway, error);
    await recordUsage(
      primaryUsageRow({
        status: 'error',
        errorMessage: safeGatewayErrorMessage(normalizedError),
      }),
    );
    await log('error', null);
    return upstreamErrorResponse(normalizedError, 'The transcription request failed.');
  }

  let processedText: string | undefined;
  let processorRecord: {
    usage: NormalizedUsage;
    costUsd: number | null;
    latencyMs: number;
    gatewayRequestId: string | null;
  } | null = null;
  if (processorModel && ctx.systemPrompt) {
    if (ctx.monthlyCostCapUsd != null) {
      // Add this request's reported STT cost to the durable monthly total before
      // deciding whether to start stage two. This avoids writing an interim
      // successful request row that could later contradict a failed HTTP result.
      // It is not an atomic reservation: concurrent client requests can race.
      let recordedSpend = ctx.monthlyCostUsedUsd ?? 0;
      try {
        // Refresh the pre-call snapshot so completed concurrent requests are
        // reflected when the database is healthy.
        recordedSpend = await costUsedThisMonth(ctx.keyId);
      } catch (error) {
        // STT has already incurred cost. Fall back to the route's admitted
        // snapshot so a transient quota-read failure cannot skip accounting or
        // turn this into an unshaped 500 after the paid call.
        console.error('[transcription] failed to refresh monthly spend after STT', {
          keyId: ctx.keyId,
          error,
        });
      }
      const spendAfterTranscription = recordedSpend + (transcriptionCost ?? 0);
      if (spendAfterTranscription >= ctx.monthlyCostCapUsd) {
        const errorMessage = 'Monthly cost budget exceeded after transcription.';
        await recordUsage(
          primaryUsageRow({
            status: 'error',
            costUsd: transcriptionCost,
            errorMessage,
          }),
        );
        await log('error', null);
        return openAiError(402, 'insufficient_quota', 'Monthly cost budget exceeded.', {
          code: 'quota_exceeded',
        });
      }
    }

    const processorStartedAt = Date.now();
    try {
      const prompt = transcriptProcessorPrompt(ctx.systemPrompt, transcript);
      const result = await generateText({
        model: ctx.gateway.gateway.languageModel(processorModel),
        system: prompt.system,
        prompt: prompt.prompt,
        temperature: ctx.params.temperature,
        topP: ctx.params.topP,
        maxOutputTokens: ctx.params.maxOutputTokens,
        abortSignal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      processedText = result.text;
      processorRecord = {
        usage: normalizeUsage(result.usage),
        costUsd: extractGatewayCost(result.providerMetadata),
        latencyMs: Date.now() - processorStartedAt,
        gatewayRequestId: extractGatewayRequestId(result.providerMetadata),
      };
    } catch (error) {
      const normalizedError = await normalizeProjectGatewayError(ctx.gateway, error);
      const processorErrorMessage = safeGatewayErrorMessage(normalizedError);
      const primary = primaryUsageRow({
        status: 'error',
        costUsd: transcriptionCost,
        errorMessage: `Transcript processing failed: ${processorErrorMessage}`,
      });
      const processor = processorUsageRow({
        status: 'error',
        latencyMs: Date.now() - processorStartedAt,
        errorMessage: processorErrorMessage,
      });
      await recordUsageBatch(processor ? [primary, processor] : [primary]);
      await log('error', null);
      return upstreamErrorResponse(normalizedError, 'The transcript could not be processed.');
    }
  }

  const payload = toAudioTranscriptionResponse({
    transcript,
    processedText,
    language: transcriptionResult.language,
    durationInSeconds: transcriptionResult.durationInSeconds,
  });
  const primary = primaryUsageRow({
    status: 'ok',
    costUsd: transcriptionCost,
  });
  if (processorRecord) {
    const processor = processorUsageRow({
      status: 'ok',
      ...processorRecord,
    });
    await recordUsageBatch(processor ? [primary, processor] : [primary]);
  } else {
    await recordUsage(primary);
  }
  await log('ok', payload.text);
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
}
