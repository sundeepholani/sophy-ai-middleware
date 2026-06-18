/**
 * LLM-as-judge: blind, position-bias-controlled pairwise comparison of the
 * champion vs challenger output for one transaction.
 *
 * The judge NEVER sees model names or which side is which — it sees the operator
 * system prompt, the user request, and two outputs labelled "Response A/B" in a
 * randomized order. We map A/B back to champion/challenger after the verdict.
 */
import { generateText, Output, jsonSchema } from 'ai';
import type { ModelMessage } from 'ai';
import { extractGatewayCost } from '@/lib/usage/record';
import type { EvalWinner } from '@/db/schema';

export interface JudgeVerdict {
  winner: EvalWinner; // champion | challenger | tie
  confidence: number; // 0..1
  reason: string;
  costUsd: number | null;
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
  '"tie". Respond only with the structured verdict (winner, confidence 0-1, one-sentence reason).';

function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === 'string'
          ? p
          : typeof (p as { text?: unknown })?.text === 'string'
            ? (p as { text: string }).text
            : JSON.stringify(p),
      )
      .join('');
  }
  return JSON.stringify(content);
}

function renderConversation(messages: ModelMessage[]): string {
  return messages
    .map((m) => `${(m.role ?? 'user').toUpperCase()}: ${renderContent(m.content)}`)
    .join('\n\n');
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

  const prompt = [
    `## Operator system instruction\n${args.systemPrompt?.trim() || '(none)'}`,
    `## User request\n${renderConversation(args.messages)}`,
    `## Response A\n${responseA}`,
    `## Response B\n${responseB}`,
    'Which response is better — "A", "B", or "tie"?',
  ].join('\n\n');

  const result = await generateText({
    model: args.judgeModel,
    system: JUDGE_SYSTEM,
    prompt,
    experimental_output: Output.object({ schema: jsonSchema(JUDGE_SCHEMA) }),
    providerOptions: { gateway: { tags: ['eval:judge'] } } as never,
  });

  const out = result.experimental_output as { winner: 'A' | 'B' | 'tie'; confidence: number; reason: string };
  let winner: EvalWinner;
  if (out.winner === 'tie') winner = 'tie';
  else if (out.winner === 'A') winner = swapped ? 'challenger' : 'champion';
  else winner = swapped ? 'champion' : 'challenger';

  const confidence = Math.max(0, Math.min(1, Number(out.confidence)));
  return {
    winner,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 2000) : '',
    costUsd: extractGatewayCost(result.providerMetadata),
    orderSwapped: swapped,
  };
}
