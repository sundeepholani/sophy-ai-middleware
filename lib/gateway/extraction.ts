/**
 * Typed extraction on Cloudflare Workers AI Clairic (POST /v1/extract).
 *
 * Native and buffered, NOT OpenAI-compatible. The key owns the model, which must
 * be a registered `extraction` entry (D9); the upstream URL and body selector
 * come only from the static registry (D4). Clairic is a research preview whose
 * output drifts, so answers pass through unmodified (D9).
 *
 * Only the project's Cloudflare credential pays (ctx.cloudflare). Failures are
 * normalised by normalizeProjectCloudflareError, which can only ever touch the
 * Cloudflare row — never the Vercel gateway credential (D3, D8).
 *
 * Do not import lib/gateway/assessments.ts: retries and the asset summary live
 * in retries.ts / image-assets.ts (contract §5 B2).
 */
import { randomUUID } from 'node:crypto';
import { APICallError } from 'ai';
import {
  recordExtractionLog,
  recordUsage,
  ZERO_USAGE,
  type NormalizedUsage,
} from '@/lib/usage/record';
import type { ExtractionAnswer, ExtractionResponse } from '@/lib/http/openai';
import { safeGatewayErrorMessage, upstreamErrorResponse } from '@/lib/gateway/upstream-error';
import { providerOf } from '@/lib/gateway/provider-of';
import { getCloudflareModel, requireCloudflareModel } from '@/lib/gateway/cloudflare-models';
import {
  callCloudflareModel,
  cloudflareCostUsd,
  cloudflareErrorInfo,
  cloudflareErrorRequestId,
  cloudflareRunUrlForLogs,
  type CloudflareErrorInfo,
} from '@/lib/gateway/cloudflare-call';
import {
  normalizeProjectCloudflareError,
  type ProjectCloudflareSnapshot,
} from '@/lib/gateway/cloudflare-provider';
import { NATIVE_UPSTREAM_TIMEOUT_MS } from '@/lib/gateway/retries';
import { summarizeAssets } from '@/lib/gateway/image-assets';
import { toClairicRequest, type ParsedExtractionRequest } from '@/lib/gateway/extraction-parse';

export { toClairicRequest }; // defined in the pure parser module, so the pre-cap estimates the exact body

/** D9 guard, synchronous and registry-only: fails CLOSED for every other id (no catalog, no fail-open). */
export function isExtractionModel(model: string): boolean {
  return getCloudflareModel(model)?.type === 'extraction';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function finite(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Pure: Clairic's `result` → the client payload. Null means unusable (the caller
 * makes it a non-retryable 502): `answers` is not a plain object, or an asked field
 * is not an OWN key of it, or its answer is not a plain object. Answers nobody asked
 * for are dropped; the asked ones pass through unmodified. `state_text` is returned
 * only when the client asked for it. `model` is always the key's id, never the
 * upstream echo ('clairic').
 */
export function toExtractionResponse(
  result: Record<string, unknown>,
  model: string,
  asked: string[],
  returnStateText: boolean,
): ExtractionResponse | null {
  const rawAnswers = result.answers;
  if (!isPlainObject(rawAnswers)) return null;
  const answers: [string, ExtractionAnswer][] = [];
  for (const name of asked) {
    // Own keys only: a missing "__proto__" answer must not read Object.prototype.
    if (!Object.hasOwn(rawAnswers, name)) return null;
    const answer = rawAnswers[name];
    if (!isPlainObject(answer)) return null;
    answers.push([name, answer as ExtractionAnswer]);
  }
  const rawUsage = result.usage;
  const usage: Record<string, unknown> = isPlainObject(rawUsage) ? rawUsage : {};
  const inputTokens = finite(usage.input_tokens);
  const outputTokens = finite(usage.output_tokens);
  const stateText = result.state_text;
  return {
    model,
    answers: Object.fromEntries(answers), // own keys, "__proto__" included
    truncated: result.truncated === true,
    ...(returnStateText && typeof stateText === 'string' ? { state_text: stateText } : {}),
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}

/**
 * U1: a 2xx that Cloudflare billed but Sophy could not use is still metered. Its
 * cf-ai-neurons ride on the error's CloudflareErrorInfo (A's unusable envelope or a
 * deadline that fired mid-body, or this handler's unusable answer), priced as a
 * neurons-only call. Anything Cloudflare rejected (4xx, 5xx, network) carries no
 * neurons, and neither does a billed response without the header: null, so the row
 * keeps a NULL cost (D6).
 */
function billedErrorCostUsd(model: string, err: unknown): number | null {
  const neurons = cloudflareErrorInfo(err)?.neurons;
  if (typeof neurons !== 'number' || !Number.isFinite(neurons)) return null;
  // Billed data implies requireCloudflareModel passed for this id; the guard only keeps
  // the error path from ever throwing (cloudflareCostUsd fails closed on unregistered ids).
  if (!getCloudflareModel(model)) return null;
  return cloudflareCostUsd({ model, neurons, inputTokens: 0, outputTokens: 0 });
}

export interface ExtractionCallContext {
  keyId: string;
  /** The key's registered extraction model id, e.g. '@cf/cloudflare/clairic'. */
  model: string;
  /** When true, capture state/fields/answers to request_logs (never image bytes or state_text). */
  logContent: boolean;
  /** The project's Cloudflare credential: it pays and is attributed (D7). */
  cloudflare: ProjectCloudflareSnapshot;
}

/**
 * Run one extraction and record it. Mirrors handleAssessment's Cloudflare branch
 * (contract §2.12): one usage row per request (ok or error) under an id shared
 * with the request log; the usage row goes in BEFORE the log, because
 * request_logs has a FK onto usage_events and recordUsage swallows its failures.
 * Retries happen inside callCloudflareModel (withRetries), so a call that
 * succeeds on a retry still records exactly one usage row.
 */
export async function handleExtraction(
  ctx: ExtractionCallContext,
  parsed: ParsedExtractionRequest,
): Promise<Response> {
  const startedAt = Date.now();
  const provider = providerOf(ctx.model); // 'cloudflare'
  const eventId = randomUUID();
  const { projectId, cloudflareCredentialId } = ctx.cloudflare;
  const logExtraction = (status: 'ok' | 'error', answers: unknown, truncated?: boolean) =>
    ctx.logContent
      ? recordExtractionLog({
          id: eventId,
          projectId,
          keyId: ctx.keyId,
          state: parsed.state,
          fields: parsed.fields,
          assets: summarizeAssets(parsed.assets), // format + decoded size only, never bytes
          ...(parsed.referenceDate !== undefined ? { referenceDate: parsed.referenceDate } : {}),
          ...(Object.keys(parsed.options).length > 0 ? { options: parsed.options } : {}),
          answers, // the answers map only: state_text is NEVER logged
          ...(truncated !== undefined ? { truncated } : {}),
          status,
        })
      : Promise.resolve();

  try {
    // Fail closed before any upstream call (D4): unregistered or non-extraction ids throw here.
    const entry = requireCloudflareModel(ctx.model, 'extraction');
    // One deadline across every attempt and retry wait.
    const signal = AbortSignal.timeout(NATIVE_UPSTREAM_TIMEOUT_MS);
    const run = await callCloudflareModel(ctx.cloudflare, ctx.model, toClairicRequest(parsed, entry), signal);

    const payload = toExtractionResponse(
      run.result,
      ctx.model,
      Object.keys(parsed.fields),
      parsed.options.return_state_text === true,
    );
    if (!payload) {
      // Cloudflare data on the error keeps the upstream request id on the error row
      // (cloudflareErrorRequestId reads only Cloudflare APICallError data) and the billed
      // neurons, so this spend is still metered (U1).
      const data: CloudflareErrorInfo = {
        provider: 'cloudflare',
        code: null,
        message: null,
        requestId: run.upstreamRequestId,
        neurons: run.neurons,
      };
      throw new APICallError({
        message: 'Cloudflare Workers AI returned an unusable extraction response.',
        url: cloudflareRunUrlForLogs(ctx.model), // literal {account_id} placeholder; never the account id
        requestBodyValues: { model: ctx.model },
        statusCode: 502,
        isRetryable: false,
        data,
      });
    }

    const usage: NormalizedUsage = {
      ...ZERO_USAGE,
      inputTokens: payload.usage.inputTokens,
      outputTokens: payload.usage.outputTokens,
      totalTokens: payload.usage.totalTokens,
    };
    await recordUsage({
      id: eventId,
      projectId,
      cloudflareCredentialId,
      keyId: ctx.keyId,
      provider,
      model: ctx.model,
      usage,
      // D6: neurons × $0.011/1k when cf-ai-neurons is present, else input_tokens × $0.10/M.
      costUsd: cloudflareCostUsd({
        model: ctx.model,
        neurons: run.neurons,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }),
      latencyMs: Date.now() - startedAt,
      status: 'ok',
      responseKind: 'extraction',
      gatewayRequestId: run.upstreamRequestId, // cf-ai-req-id ?? cf-ray
    });
    await logExtraction('ok', payload.answers, payload.truncated);

    return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // Cloudflare-only health handling: a 401 / 403+10000 marks the CLOUDFLARE row
    // invalid and becomes the typed 503; everything else comes back unchanged.
    const normalizedError = await normalizeProjectCloudflareError(ctx.cloudflare, err);
    const billedCostUsd = billedErrorCostUsd(ctx.model, err);
    await recordUsage({
      id: eventId,
      projectId,
      cloudflareCredentialId,
      keyId: ctx.keyId,
      provider,
      model: ctx.model,
      usage: { ...ZERO_USAGE },
      // Omitted → NULL (D6), except a billed 2xx Sophy could not use (U1).
      ...(billedCostUsd !== null ? { costUsd: billedCostUsd } : {}),
      latencyMs: Date.now() - startedAt,
      status: 'error',
      responseKind: 'extraction',
      gatewayRequestId: cloudflareErrorRequestId(err), // NULL when no Cloudflare response
      errorMessage: safeGatewayErrorMessage(normalizedError),
    });
    await logExtraction('error', null);
    return upstreamErrorResponse(normalizedError, 'The extraction request failed.');
  }
}
