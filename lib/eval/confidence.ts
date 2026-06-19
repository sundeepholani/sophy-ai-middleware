/**
 * A judge verdict it wasn't confident about isn't a real win. Below this
 * confidence we treat the verdict as a tie.
 *
 * Applied uniformly to the eval-dialog display AND the aggregate win counts /
 * recommendation, so "tie" means the same thing in the win bar, the per-sample
 * list, the summary card, and the email — never a contradiction between them.
 */
import type { EvalWinner } from '@/db/schema';

export const TIE_CONFIDENCE = 0.6;

/** Collapse a low-confidence champion/challenger verdict to a tie. */
export function effectiveWinner(winner: EvalWinner, confidence: number): EvalWinner {
  return winner !== 'tie' && confidence < TIE_CONFIDENCE ? 'tie' : winner;
}
