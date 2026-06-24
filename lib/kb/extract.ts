/**
 * Text extraction for KB ingestion. Dispatches by content-type:
 *   - text/* + application/json → UTF-8 decode
 *   - application/pdf           → unpdf (pure-JS, serverless-friendly pdf.js)
 *   - DOCX                      → mammoth (raw text)
 *
 * Output is sanitized: Postgres `text` columns reject NUL (char code 0), and
 * stray control chars from binary extraction are noise — strip them before they
 * ever reach a chunk row. (We learned the NUL lesson the hard way once already.)
 */
import { extractText as extractPdfText } from 'unpdf';
import * as mammoth from 'mammoth';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Allowed upload types for a KB: text/markdown/csv/json/pdf/docx. */
export const KB_ALLOWED_CONTENT_TYPES = new Set<string>([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  DOCX,
]);

/** Lowercase, drop any `; charset=…` parameter, trim. */
function normalizeContentType(ct: string): string {
  return (ct.split(';')[0] ?? '').trim().toLowerCase();
}

export function isKbContentTypeAllowed(contentType: string): boolean {
  return KB_ALLOWED_CONTENT_TYPES.has(normalizeContentType(contentType));
}

/**
 * Make extracted text DB-safe: drop NUL (Postgres text can't store char code 0)
 * and replace other C0 control chars with a space, keeping tab/newline/CR.
 * Implemented with a charCode scan so no literal control bytes live in source.
 */
function sanitize(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue; // NUL
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) {
      out += ' ';
      continue;
    }
    out += s[i];
  }
  return out;
}

export async function extractText(input: {
  contentType: string;
  data: ArrayBuffer;
}): Promise<string> {
  const ct = normalizeContentType(input.contentType);

  if (ct === 'application/pdf') {
    const { text } = await extractPdfText(new Uint8Array(input.data), { mergePages: true });
    return sanitize(text);
  }

  if (ct === DOCX) {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(input.data) });
    return sanitize(value);
  }

  // text/plain, text/markdown, text/csv, application/json — and any other text/*.
  if (ct === 'application/json' || ct.startsWith('text/')) {
    return sanitize(new TextDecoder('utf-8', { fatal: false }).decode(input.data));
  }

  throw new Error(`unsupported content type for KB ingestion: ${input.contentType || '(none)'}`);
}
