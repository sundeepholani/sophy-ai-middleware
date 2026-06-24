import { describe, it, expect } from 'vitest';
import { formatEvalEmail } from '@/lib/eval/email';
import type { EvalSummary } from '@/lib/eval/aggregate';

const base = {
  total: 2,
  winsChampion: 1,
  winsChallenger: 1,
  ties: 0,
  challengerWinRate: 0.5,
  ci: null,
  tieRate: 0,
  avgChampionCostUsd: 0.001,
  avgChallengerCostUsd: 0.0005,
  avgChampionLatencyMs: 100,
  avgChallengerLatencyMs: 80,
  monthlyRequests: 1000,
  projectedMonthlyCostDeltaUsd: -0.5,
  recommendation: 'keep' as const,
  headline: 'Roughly even.',
};

describe('formatEvalEmail example verdicts', () => {
  it('de-blinds A/B to model names per orderSwapped and labels the winner by model', () => {
    const summary: EvalSummary = {
      ...base,
      examples: [
        // not swapped → A = champion, B = challenger; challenger won (praises B).
        { winner: 'challenger', confidence: 0.9, reason: 'B is more accurate than A.', orderSwapped: false },
        // swapped → A = challenger, B = champion; champion won (praises B).
        { winner: 'champion', confidence: 0.8, reason: 'B cites the facts; A overstates.', orderSwapped: true },
      ],
    };
    const { html } = formatEvalEmail({
      championModel: 'anthropic/claude-sonnet-4.6',
      challengerModel: 'openai/gpt-5.4-mini',
      judgeModel: 'anthropic/claude-opus-4.8',
      summary,
    });

    // Reasons are remapped to the right model for each sample's order.
    expect(html).toContain('gpt-5.4-mini is more accurate than claude-sonnet-4.6.');
    expect(html).toContain('claude-sonnet-4.6 cites the facts; gpt-5.4-mini overstates.');
    // Winner label uses the model name, not "Challenger"/"Champion".
    expect(html).toContain('<b>gpt-5.4-mini won</b>');
    expect(html).toContain('<b>claude-sonnet-4.6 won</b>');
    // No leftover bare-letter response labels in the verdicts list.
    expect(html).not.toMatch(/won<\/b>: .*\b[AB]\b/);
  });
});
