/**
 * Price per 1M tokens for the Models screen. Two decimals from $0.10 up, and up to four below it,
 * so a sub-dime price keeps its digits ($0.038, not $0.04; D5). Trailing zeros are trimmed
 * ($3, $0.25, $1.5, $0.1). A positive price too small to show is '<$0.0001', never '$0', because
 * unknown is not free (lib/gateway/models.ts perMillion). Null or non-finite renders '—'.
 * Pure and client-safe.
 */
export function fmtUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const trimmed = n.toFixed(Math.abs(n) >= 0.1 ? 2 : 4).replace(/\.?0+$/, '');
  if (n > 0 && Number(trimmed) === 0) return '<$0.0001';
  return `$${trimmed}`;
}
