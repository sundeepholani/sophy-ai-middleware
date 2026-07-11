/**
 * LLM-as-judge: blind, position-bias-controlled pairwise comparison of the
 * champion vs challenger output for one transaction.
 *
 * The judge NEVER sees model names or which side is which — it sees the operator
 * system prompt, the user request, and two outputs labelled "Response A/B" in a
 * randomized order. We map A/B back to champion/challenger after the verdict.
 */
import type { LanguageModelUsage, ModelMessage } from 'ai';
import { generateStructured, StructuredAttemptError } from '@/lib/gateway/structured';
import { normalizeUsage, type NormalizedUsage } from '@/lib/usage/record';
import { evalModel } from '@/lib/eval/model';
import type { EvalWinner } from '@/db/schema';

const JUDGE_TIMEOUT_MS = 60_000;

// Size guards for the judge prompt. Without them a single non-text part
// (base64 image) stringified into the prompt can balloon a ~1K-token judging
// task into an ~850K-token opus call — observed in production on 2026-07-10,
// where 11 such calls (retries included) billed ~$30 and recorded $0.
const MAX_SYSTEM_CHARS = 20_000;
const MAX_CONVERSATION_CHARS = 60_000;
const MAX_RESPONSE_CHARS = 40_000;

/**
 * A judge failure that still carries the gateway cost (and tokens, when known)
 * of the billed attempt(s), so the caller can persist the spend even though no
 * verdict was produced.
 */
export class JudgeError extends Error {
  constructor(
    message: string,
    readonly costUsd: number | null,
    readonly usage?: LanguageModelUsage,
  ) {
    super(message);
    this.name = 'JudgeError';
  }
}

export interface JudgeVerdict {
  winner: EvalWinner; // champion | challenger | tie
  confidence: number; // 0..1
  reason: string;
  costUsd: number | null;
  /** Tokens across every billed judge attempt — for the usage_events row. */
  usage: NormalizedUsage;
  orderSwapped: boolean; // true ⇒ challenger was shown as "Response A"
}

const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    winner: { type: 'string', enum: ['A', 'B', 'tie'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
  required: ['winner', 'confidence', 'reason'],
};

const JUDGE_SYSTEM =
  'You are an impartial evaluator. You will see an operator system instruction, a user request, ' +
  'and two candidate assistant responses labelled "Response A" and "Response B". Decide which ' +
  'response better fulfils the operator instruction and the user request. Prioritize correctness, ' +
  'instruction-following, factual accuracy, and relevance. Explicitly IGNORE response length and ' +
  'verbosity, and do not prefer a response because of its position (A or B). If a response is ' +
  'required to be valid JSON and is not, it loses. If the two are equivalent in quality, answer ' +
  '"tie". In the reason, refer to the candidates only as "Response A" and "Response B" in full — ' +
  'never as a bare "A" or "B". Markers like "…[truncated for judging]", "…[earlier conversation ' +
  'truncated]", or "[… part omitted]" are evaluation artifacts, not response content: judge on the ' +
  'visible material and never penalize a response for truncation effects (for example JSON cut off ' +
  'mid-document by the marker). Respond only with the structured verdict (winner, confidence 0-1, ' +
  'one-sentence reason).';

/**
 * Text rendering of message content for the judge prompt. Non-text parts
 * (images, files, tool payloads) are NEVER inlined — a placeholder names the
 * part type instead. Stringifying them would inject raw base64 into the prompt
 * and multiply its token count by orders of magnitude; the judge can't see
 * media anyway, so the placeholder loses nothing it could have used.
 */
function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === 'string'
          ? p
          : typeof (p as { text?: unknown })?.text === 'string'
            ? (p as { text: string }).text
            : `[${typeof (p as { type?: unknown })?.type === 'string' ? (p as { type: string }).type : 'non-text'} part omitted]`,
      )
      .join('');
  }
  return typeof content === 'object' && content !== null ? '[non-text content omitted]' : String(content);
}

function renderConversation(messages: ModelMessage[]): string {
  return messages
    .map((m) => `${(m.role ?? 'user').toUpperCase()}: ${renderContent(m.content)}`)
    .join('\n\n');
}

/** Head-keep truncation with an explicit marker so the judge knows. */
function capSection(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated for judging]` : s;
}

/**
 * Tail-keep truncation for the conversation: it renders oldest-first, and the
 * one part the judge must never lose is the FINAL user turn — the request both
 * responses actually answer — so overflow drops the oldest turns instead.
 */
function capConversation(s: string, max: number): string {
  return s.length > max ? `…[earlier conversation truncated]\n${s.slice(-max)}` : s;
}

/**
 * The full judge prompt for one comparison. Pure — exported for unit testing.
 * Every section is individually capped so no single oversized system prompt,
 * conversation, or response can produce a runaway-cost judge call.
 */
export function buildJudgePrompt(args: {
  systemPrompt: string | null;
  messages: ModelMessage[];
  responseA: string;
  responseB: string;
}): string {
  return [
    `## Operator system instruction\n${capSection(args.systemPrompt?.trim() || '(none)', MAX_SYSTEM_CHARS)}`,
    `## User request\n${capConversation(renderConversation(args.messages), MAX_CONVERSATION_CHARS)}`,
    `## Response A\n${capSection(args.responseA, MAX_RESPONSE_CHARS)}`,
    `## Response B\n${capSection(args.responseB, MAX_RESPONSE_CHARS)}`,
    'Which response is better — "A", "B", or "tie"?',
  ].join('\n\n');
}

export async function judge(args: {
  judgeModel: string;
  systemPrompt: string | null;
  messages: ModelMessage[];
  championOutput: string;
  challengerOutput: string;
  randomSwap: boolean;
}): Promise<JudgeVerdict> {
  const swapped = args.randomSwap;
  const responseA = swapped ? args.challengerOutput : args.championOutput;
  const responseB = swapped ? args.championOutput : args.challengerOutput;

  const prompt = buildJudgePrompt({
    systemPrompt: args.systemPrompt,
    messages: args.messages,
    responseA,
    responseB,
  });

  // Tolerant structured generation so a non-native judge model (or a transient
  // strict-mode hiccup) doesn't crash the sample (see lib/gateway/structured.ts).
  // Our AJV validation enforces the schema — incl. the winner enum — so an invalid
  // verdict fails the sample rather than silently counting as 'B'.
  let result: Awaited<ReturnType<typeof generateStructured>>;
  try {
    result = await generateStructured(
      {
        model: evalModel(args.judgeModel),
        system: JUDGE_SYSTEM,
        prompt,
      },
      JUDGE_SCHEMA,
      // Fresh 60s budget PER attempt: a shared signal would leave the tolerant
      // retry seconds from abort after a slow strict attempt — a paid failure.
      { attemptTimeoutMs: JUDGE_TIMEOUT_MS },
    );
  } catch (e) {
    // The retry failed after a completed (billed) strict attempt — surface the
    // known judge spend to the caller instead of losing it with the sample.
    if (e instanceof StructuredAttemptError) {
      throw new JudgeError(`judge call failed after a billed attempt: ${e.message}`, e.costUsd, e.usage);
    }
    throw e;
  }
  // Invalid verdicts still came from BILLED judge call(s) — throw with the cost
  // attached so the caller can persist the spend on the failed sample.
  if (!result.valid) {
    throw new JudgeError(
      `judge did not return a valid verdict: ${result.errors ?? 'unparseable output'}`,
      result.costUsd,
      result.usage,
    );
  }
  const out = result.value as { winner?: unknown; confidence?: unknown; reason?: unknown };
  if (out.winner !== 'A' && out.winner !== 'B' && out.winner !== 'tie') {
    throw new JudgeError(
      `judge returned an invalid winner: ${JSON.stringify(out.winner)}`,
      result.costUsd,
      result.usage,
    );
  }
  let winner: EvalWinner;
  if (out.winner === 'tie') winner = 'tie';
  else if (out.winner === 'A') winner = swapped ? 'challenger' : 'champion';
  else winner = swapped ? 'champion' : 'challenger';

  const confidence = Math.max(0, Math.min(1, Number(out.confidence)));
  return {
    winner,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 2000) : '',
    // Aggregated across attempts — the tolerant retry path bills two calls.
    costUsd: result.costUsd,
    usage: normalizeUsage(result.usage),
    orderSwapped: swapped,
  };
}
