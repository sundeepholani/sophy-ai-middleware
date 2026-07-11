/**
 * Tolerant structured-output generation, shared by the proxy and the eval.
 *
 * The AI SDK's `Output.object` (`experimental_output`) does a STRICT parse and
 * throws `NoObjectGeneratedError` on anything that isn't cleanly parseable JSON —
 * before our own `validateAgainstSchema` runs. Models that wrap their JSON in a
 * ```json fence or pad it with prose (GLM, kimi, many open models) then fail hard,
 * even when the JSON they produced is perfectly valid.
 *
 * `generateStructured` keeps the strict path for models that satisfy it natively
 * (OpenAI/Anthropic — unchanged), and adds a TOLERANT fallback that extracts the
 * JSON from the raw text and validates it ourselves. The fallback only runs when
 * the strict path would otherwise fail, so a call that succeeds today is untouched.
 *
 * The fallback also covers SCHEMA REJECTIONS: some user schemas are valid JSON
 * Schema yet violate a provider's native structured-mode constraints — OpenAI
 * strict mode requires every key in `properties` to appear in `required`, and
 * Anthropic refuses an empty `{}` sub-schema. The provider then 400s before
 * generating anything. Rather than surface a hard error, we drop native mode and
 * re-ask with the schema inline (the plain-text retry), validating ourselves.
 */
import { generateText, Output, jsonSchema, NoObjectGeneratedError } from 'ai';
import type { LanguageModelUsage, ProviderMetadata, FinishReason } from 'ai';
import { validateAgainstSchema } from '@/lib/gateway/openai-map';
import { extractGatewayCost } from '@/lib/usage/record';

/**
 * True when the provider rejected our JSON schema in its native structured mode
 * (rather than failing to generate). Shows up as a 400 whose message references
 * the response format / output schema — e.g. OpenAI strict mode demanding every
 * key in `required`, or Anthropic refusing an empty `{}` sub-schema. These are
 * recoverable by dropping native mode and re-asking with the schema inline.
 */
export function isSchemaRejection(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  if ((e as { statusCode?: number }).statusCode !== 400) return false;
  const message = (e as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return /response_format|output_config\.format|format\.schema|invalid schema|empty schema|required to be supplied|additionalproperties/i.test(
    message,
  );
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** The first balanced `{…}` object in `text`, quote/escape aware (so a `}` inside
 *  a string value doesn't close the object early). Returns undefined if none /
 *  the object is truncated (never closes). */
function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Best-effort extraction of a JSON value from model text: (a) parse as-is,
 * (b) strip a ```json … ``` / ``` … ``` fence, (c) take the first balanced object.
 * Returns undefined if nothing parses.
 */
export function extractJsonObject(text: string): unknown {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }

  const sliced = firstBalancedObject(trimmed);
  if (sliced !== undefined) {
    const parsed = tryParse(sliced);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** Extract a JSON value from text and validate it against `schema`. */
export function coerceToSchema(
  text: string,
  schema: Record<string, unknown>,
): { valid: boolean; value: unknown; errors: string | null } {
  const value = extractJsonObject(text);
  if (value === undefined) {
    return { valid: false, value: undefined, errors: 'No parseable JSON object in the model output.' };
  }
  const check = validateAgainstSchema(value, schema);
  return { valid: check.valid, value, errors: check.errors };
}

export interface StructuredResult {
  /** Whether we have an object that satisfies the schema. */
  valid: boolean;
  /** The parsed object (when valid) — otherwise the best-effort extracted value. */
  value: unknown;
  /** Canonical JSON when valid; the model's raw text otherwise. */
  text: string;
  /** Schema/parse error detail when invalid; null when valid. */
  errors: string | null;
  /** Token usage summed across EVERY billed attempt (strict + plain-text retry). */
  usage: LanguageModelUsage | undefined;
  /** The LAST attempt's provider metadata (gateway request id correlation). */
  providerMetadata: ProviderMetadata | undefined;
  /**
   * Zero-markup gateway cost summed across every attempt that reported one, or
   * null when none did. Callers must charge THIS, not extractGatewayCost of
   * providerMetadata — the retry path makes two billed calls and the metadata
   * only carries the last one.
   */
  costUsd: number | null;
  /** The finish reason of the call whose output we used (for truncation/filter signal). */
  finishReason: FinishReason | undefined;
  /** True when the tolerant fallback rescued an output the strict parser rejected. */
  recovered: boolean;
}

/** Sum two usage reports field-by-field; undefined inputs contribute nothing. */
export function sumUsage(
  a: LanguageModelUsage | undefined,
  b: LanguageModelUsage | undefined,
): LanguageModelUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const n = (x: number | undefined) => x ?? 0;
  return {
    inputTokens: n(a.inputTokens) + n(b.inputTokens),
    outputTokens: n(a.outputTokens) + n(b.outputTokens),
    totalTokens: n(a.totalTokens) + n(b.totalTokens),
    cachedInputTokens: n(a.cachedInputTokens) + n(b.cachedInputTokens),
    reasoningTokens: n(a.reasoningTokens) + n(b.reasoningTokens),
  } as LanguageModelUsage;
}

/** Sum gateway costs; null only when NO attempt reported a cost. */
export function sumCost(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return a + b;
}

/**
 * The plain-text retry failed AFTER a completed (billed) strict attempt. The
 * strict attempt's cost/usage are carried here so callers can still charge
 * them — recording ZERO_USAGE for a request whose first attempt completed is
 * exactly the billed-but-unrecorded class behind the 2026-07-10 incident.
 */
export class StructuredAttemptError extends Error {
  constructor(
    message: string,
    readonly costUsd: number | null,
    readonly usage: LanguageModelUsage | undefined,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = 'StructuredAttemptError';
  }
}

type GenerateTextArgs = Parameters<typeof generateText>[0];

function ok(
  value: unknown,
  usage: StructuredResult['usage'],
  providerMetadata: StructuredResult['providerMetadata'],
  costUsd: number | null,
  finishReason: FinishReason | undefined,
  recovered: boolean,
): StructuredResult {
  return { valid: true, value, text: JSON.stringify(value), errors: null, usage, providerMetadata, costUsd, finishReason, recovered };
}

/**
 * Append an explicit JSON-only + schema instruction to the system prompt for the
 * plain-text retry. Models that ignore the SDK's structured mode (and emit prose)
 * usually comply with a direct instruction; the schema tells them the target shape
 * the way native structured mode would.
 */
function withJsonInstruction(system: string | undefined, schema: Record<string, unknown>): string {
  const instr =
    'Respond with ONLY a single JSON object that conforms to the JSON Schema below. ' +
    'Output nothing else — no prose, no explanation, no markdown code fences.\n\nJSON Schema:\n' +
    JSON.stringify(schema);
  return system && system.trim() ? `${system}\n\n${instr}` : instr;
}

/**
 * Generate schema-constrained output, resilient to models that don't satisfy the
 * SDK's strict structured mode.
 *
 * 1. **Strict** `Output.object` — native for OpenAI/Anthropic; returned unchanged
 *    when it produces a schema-valid object (the common path).
 * 2. **Tolerant extract** of the strict attempt's raw text (rescues output that
 *    merely wrapped its JSON in a ```fence).
 * 3. **Plain-text retry** — some models (GLM, kimi, …) emit *prose* under the
 *    SDK's structured mode but clean (often fenced) JSON in a normal call, so we
 *    re-ask without `experimental_output` and tolerant-extract. Only reached when
 *    the strict path already failed, so native models never pay for it. This also
 *    rescues SCHEMA REJECTIONS — a provider 400 that refused the schema in native
 *    mode (see `isSchemaRejection`) — since the retry sends no native schema.
 *
 * Other upstream errors (timeouts/transient/auth failures) re-throw so callers
 * handle them exactly as before.
 *
 * `opts.attemptTimeoutMs` gives EACH attempt its own fresh abort budget. Without
 * it, a caller-supplied `args.abortSignal` is shared across attempts — a slow
 * strict attempt leaves the retry seconds from abort, guaranteeing a paid
 * failure. Callers that time-bound the call should prefer this option.
 */
export async function generateStructured(
  args: GenerateTextArgs,
  schema: Record<string, unknown>,
  opts?: { attemptTimeoutMs?: number },
): Promise<StructuredResult> {
  const withAttemptSignal = (a: GenerateTextArgs): GenerateTextArgs =>
    opts?.attemptTimeoutMs != null
      ? { ...a, abortSignal: AbortSignal.timeout(opts.attemptTimeoutMs) }
      : a;
  let strictText = '';
  let usage: StructuredResult['usage'];
  let providerMetadata: StructuredResult['providerMetadata'];
  let costUsd: number | null = null;
  let finishReason: FinishReason | undefined;
  let strictErrors: string | null = null;

  // ---- 1) strict structured mode -------------------------------------------
  try {
    const r = await generateText(
      withAttemptSignal({
        ...args,
        experimental_output: Output.object({ schema: jsonSchema(schema) }),
      }),
    );
    const obj = r.experimental_output as unknown;
    const strict = validateAgainstSchema(obj, schema);
    const strictCost = extractGatewayCost(r.providerMetadata);
    if (strict.valid) return ok(obj, r.usage, r.providerMetadata, strictCost, r.finishReason, false);
    strictText = r.text;
    usage = r.usage;
    providerMetadata = r.providerMetadata;
    costUsd = strictCost;
    finishReason = r.finishReason;
    strictErrors = strict.errors;
  } catch (e) {
    if (NoObjectGeneratedError.isInstance(e)) {
      strictText = typeof e.text === 'string' ? e.text : '';
      usage = e.usage;
      // The error carries no gateway cost metadata — the attempt WAS billed but
      // its cost is unrecoverable here; usage (tokens) still counts toward the
      // aggregate so the under-record is visible in token totals.
      providerMetadata = undefined;
      finishReason = e.finishReason;
    } else if (!isSchemaRejection(e)) {
      throw e; // genuine upstream error (auth/rate-limit/timeout) → propagate
    }
    // A schema rejection leaves strictText empty: step 2 finds nothing to coerce
    // and we fall through to the plain-text retry (step 3), which re-asks with
    // the schema as a prompt instruction — sidestepping native strict mode.
  }

  // ---- 2) tolerant extract of the strict attempt ---------------------------
  const fromStrict = coerceToSchema(strictText, schema);
  if (fromStrict.valid) return ok(fromStrict.value, usage, providerMetadata, costUsd, finishReason, true);

  // ---- 3) plain-text retry with an explicit JSON+schema instruction ---------
  // A real failure here (timeout/transient) propagates — it's an upstream error,
  // not a schema validation outcome. But when the STRICT attempt completed (and
  // was billed), its cost/usage ride along on a StructuredAttemptError so the
  // caller's error accounting can still charge them.
  const baseSystem = typeof args.system === 'string' ? args.system : undefined;
  let r2: Awaited<ReturnType<typeof generateText>>;
  try {
    r2 = await generateText(
      withAttemptSignal({ ...args, system: withJsonInstruction(baseSystem, schema) }),
    );
  } catch (e) {
    if (costUsd != null || usage) {
      throw new StructuredAttemptError(e instanceof Error ? e.message : String(e), costUsd, usage, e);
    }
    throw e;
  }
  // BOTH attempts were billed: aggregate tokens and cost so accounting charges
  // the retry path fully instead of silently dropping the strict attempt.
  const totalUsage = sumUsage(usage, r2.usage);
  const totalCost = sumCost(costUsd, extractGatewayCost(r2.providerMetadata));
  const c2 = coerceToSchema(r2.text, schema);
  if (c2.valid) return ok(c2.value, totalUsage, r2.providerMetadata, totalCost, r2.finishReason, true);
  return {
    valid: false,
    value: undefined,
    text: r2.text,
    errors: c2.errors ?? fromStrict.errors ?? strictErrors,
    usage: totalUsage,
    providerMetadata: r2.providerMetadata,
    costUsd: totalCost,
    finishReason: r2.finishReason,
    recovered: false,
  };
}
