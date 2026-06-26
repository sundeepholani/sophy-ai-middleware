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
 */
import { generateText, Output, jsonSchema, NoObjectGeneratedError } from 'ai';
import type { LanguageModelUsage, ProviderMetadata, FinishReason } from 'ai';
import { validateAgainstSchema } from '@/lib/gateway/openai-map';

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
  usage: LanguageModelUsage | undefined;
  providerMetadata: ProviderMetadata | undefined;
  /** The finish reason of the call whose output we used (for truncation/filter signal). */
  finishReason: FinishReason | undefined;
  /** True when the tolerant fallback rescued an output the strict parser rejected. */
  recovered: boolean;
}

type GenerateTextArgs = Parameters<typeof generateText>[0];

function ok(
  value: unknown,
  usage: StructuredResult['usage'],
  providerMetadata: StructuredResult['providerMetadata'],
  finishReason: FinishReason | undefined,
  recovered: boolean,
): StructuredResult {
  return { valid: true, value, text: JSON.stringify(value), errors: null, usage, providerMetadata, finishReason, recovered };
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
 *    the strict path already failed, so native models never pay for it.
 *
 * Non-parse errors (timeouts/transient upstream failures) re-throw so callers
 * handle them exactly as before.
 */
export async function generateStructured(
  args: GenerateTextArgs,
  schema: Record<string, unknown>,
): Promise<StructuredResult> {
  let strictText = '';
  let usage: StructuredResult['usage'];
  let providerMetadata: StructuredResult['providerMetadata'];
  let finishReason: FinishReason | undefined;
  let strictErrors: string | null = null;

  // ---- 1) strict structured mode -------------------------------------------
  try {
    const r = await generateText({
      ...args,
      experimental_output: Output.object({ schema: jsonSchema(schema) }),
    });
    const obj = r.experimental_output as unknown;
    const strict = validateAgainstSchema(obj, schema);
    if (strict.valid) return ok(obj, r.usage, r.providerMetadata, r.finishReason, false);
    strictText = r.text;
    usage = r.usage;
    providerMetadata = r.providerMetadata;
    finishReason = r.finishReason;
    strictErrors = strict.errors;
  } catch (e) {
    if (!NoObjectGeneratedError.isInstance(e)) throw e; // real error → propagate
    strictText = typeof e.text === 'string' ? e.text : '';
    usage = e.usage;
    providerMetadata = undefined; // the error carries no gateway cost metadata
    finishReason = e.finishReason;
  }

  // ---- 2) tolerant extract of the strict attempt ---------------------------
  const fromStrict = coerceToSchema(strictText, schema);
  if (fromStrict.valid) return ok(fromStrict.value, usage, providerMetadata, finishReason, true);

  // ---- 3) plain-text retry with an explicit JSON+schema instruction ---------
  // A real failure here (timeout/transient) propagates — it's an upstream error,
  // not a schema validation outcome.
  const baseSystem = typeof args.system === 'string' ? args.system : undefined;
  const r2 = await generateText({ ...args, system: withJsonInstruction(baseSystem, schema) });
  const c2 = coerceToSchema(r2.text, schema);
  if (c2.valid) return ok(c2.value, r2.usage, r2.providerMetadata, r2.finishReason, true);
  return {
    valid: false,
    value: undefined,
    text: r2.text,
    errors: c2.errors ?? fromStrict.errors ?? strictErrors,
    usage: r2.usage,
    providerMetadata: r2.providerMetadata,
    finishReason: r2.finishReason,
    recovered: false,
  };
}
