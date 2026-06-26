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
  const out = reason.replace(/\bResponse A\b/g, a).replace(/\bResponse B\b/g, b);
  // Legacy best-effort for older reasons that used a bare "A"/"B" — applied ONLY
  // when the reason never used the full "Response A/B" form. Otherwise this would
  // rewrite ordinary capitalized "A"/"B" words (e.g. "an A-grade answer", "Plan B").
  if (/\bResponse [AB]\b/.test(reason)) return out;
  return out.replace(/\bA\b/g, a).replace(/\bB\b/g, b);
}
