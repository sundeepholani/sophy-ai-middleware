/**
 * De-blinding helpers for displaying judge verdicts.
 *
 * The judge grades blind: it sees the two outputs as "Response A"/"Response B"
 * in a randomized order per sample (orderSwapped ⇒ the challenger was shown as
 * "A"). Its reason text therefore references bare A/B that mean different models
 * from one sample to the next. When surfacing a reason to the operator (eval
 * panel, summary email) we remap A/B back to the actual model names so each
 * reason is directly readable.
 *
 * Pure string utilities — safe to import from both client and server.
 */

/** Short, scannable model name (drop the provider prefix). */
export function shortModel(m: string): string {
  return m.split('/').pop() || m;
}

/**
 * Replace the judge's blind "A"/"B" with the actual model names for this sample.
 * New reasons say "Response A"/"Response B" in full (exact remap); older
 * bare-letter reasons are remapped best-effort.
 */
export function deblindReason(
  reason: string,
  orderSwapped: boolean,
  championModel: string,
  challengerModel: string,
): string {
  if (!reason) return reason;
  const a = shortModel(orderSwapped ? challengerModel : championModel);
  const b = shortModel(orderSwapped ? championModel : challengerModel);
  return reason
    .replace(/\bResponse A\b/g, a)
    .replace(/\bResponse B\b/g, b)
    .replace(/\bA\b/g, a)
    .replace(/\bB\b/g, b);
}
