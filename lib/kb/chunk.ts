/**
 * Pure text chunker for KB ingestion. Splits a document into overlapping
 * windows (~1,000 chars, ~150 overlap) so retrieval can return self-contained
 * passages without cutting context at a hard boundary. The chunk count is
 * bounded so one huge document can't blow up embedding cost or insert size.
 *
 * Windows prefer to end on a whitespace boundary (so words aren't split), but
 * fall back to a hard cut when there's no nearby whitespace (e.g. a long
 * unbroken token). Progress per step is always positive, so it always halts.
 */
export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 150;
export const MAX_CHUNKS = 1000;

/** Index of the last whitespace char in s, or -1. */
function lastWhitespaceIndex(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (/\s/.test(s[i])) return i;
  }
  return -1;
}

export function chunkText(
  input: string,
  opts: { size?: number; overlap?: number; maxChunks?: number } = {},
): string[] {
  const size = Math.max(1, opts.size ?? CHUNK_SIZE);
  // Overlap must leave forward progress; clamp to < size.
  const overlap = Math.min(Math.max(0, opts.overlap ?? CHUNK_OVERLAP), size - 1);
  const maxChunks = Math.max(1, opts.maxChunks ?? MAX_CHUNKS);

  // Normalize line endings and collapse runs of 3+ blank lines; trim ends.
  const text = input.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < maxChunks) {
    let end = Math.min(start + size, text.length);
    // Prefer a whitespace break, but only if it isn't so early it makes a tiny
    // chunk (>60% of the window). At the document end, take everything.
    if (end < text.length) {
      const ws = lastWhitespaceIndex(text.slice(start, end));
      if (ws > size * 0.6) end = start + ws;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap); // overlap, but always advance
  }
  return chunks;
}
