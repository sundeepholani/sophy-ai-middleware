/**
 * Keyed image assets shared by /v1/evaluate and /v1/extract. The TypeSafe Jev rules
 * stay in assessments.ts; the Cloudflare Clef/Clairic rules (D8, D9) live here.
 */
import type { AssessmentAsset } from '@/lib/http/openai';

/** Moved from assessments.ts:73. NB: it admits '__proto__' — build maps with Object.fromEntries (CCR-6). */
export const ASSET_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Standard padded base64 — no whitespace, url-safe or `data:` forms. Moved from assessments.ts:76.
 * WARNING: V8 overflows its regexp stack on this pattern above ~4.47M characters (RangeError).
 * Use isStrictBase64 for anything that can be multi-MB (CCR-5).
 *
 * @deprecated Kept exported for compatibility. The overflow hits below Vercel's 4.5 MB body
 * cap, so never run it on client input; use isStrictBase64.
 */
export const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Same language as STRICT_BASE64, checked in linear time and stack-safe on multi-MB input. */
export function isStrictBase64(data: string): boolean {
  return data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);
}

/** (len / 4) * 3 − padding — the same arithmetic summarizeAssets always used. Input must be STRICT_BASE64. */
export function decodedBase64Bytes(b64: string): number {
  return (b64.length / 4) * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
}

/**
 * What the request log keeps of each image: its format and decoded size, never
 * the bytes — a base64 selfie would blow the log cap and is not ours to retain.
 */
export function summarizeAssets(
  assets: Record<string, AssessmentAsset> | undefined,
): Record<string, { format: string; bytes: number }> | undefined {
  if (!assets) return undefined;
  return Object.fromEntries(
    Object.entries(assets).map(([key, a]) => [key, { format: a.format, bytes: decodedBase64Bytes(a.data_base64) }]),
  );
}

/** Cloudflare's documented image limits for Clef and Clairic (cf-models/clef.schema.json `images`). */
export const CLOUDFLARE_IMAGE_LIMITS = {
  maxImages: 4,
  maxBytesEach: 4 * 1024 * 1024,
  maxBytesTotal: 8 * 1024 * 1024,
  formats: ['png', 'jpg', 'jpeg', 'webp'],
} as const;

export interface CloudflareImage {
  content_type: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}

/** Structurally identical to ParseAssessmentResult's failure member (assessments.ts:118-120). */
export type AssetParseFailure = { ok: false; status: number; message: string; code: string; param?: string };

function fail(message: string, code: string, param: string): AssetParseFailure {
  return { ok: false, status: 400, message, code, param };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const CLOUDFLARE_FORMATS: ReadonlySet<string> = new Set(CLOUDFLARE_IMAGE_LIMITS.formats);
const FORMAT_LABEL: Record<string, string> = { png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', webp: 'WebP' };

/** Signature check on the still-encoded data (input already passed isStrictBase64). */
function matchesSignature(format: string, data: string): boolean {
  if (format === 'png') return data.startsWith('iVBORw0KGgo'); // 89 50 4E 47 0D 0A 1A 0A
  if (format === 'jpg' || format === 'jpeg') return data.startsWith('/9j/'); // FF D8 FF
  // WebP: bytes 0-3 "RIFF", bytes 8-11 "WEBP". 16 base64 chars decode to the first 12 bytes.
  if (data.length < 16) return false;
  const head = atob(data.slice(0, 16));
  return head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP';
}

/**
 * The Clef and Clairic rules (D8, D9). Checks run in this order; the first failure wins.
 * There is NO must-be-referenced rule. Returned formats are lowercased, keys keep Object.keys order.
 */
export function parseCloudflareImageAssets(
  raw: unknown,
): { ok: true; value: Record<string, AssessmentAsset> } | AssetParseFailure {
  if (!isPlainObject(raw)) return fail('assets must be an object.', 'invalid_assets', 'assets');
  const keys = Object.keys(raw);
  if (keys.length === 0) return fail('assets must contain at least one entry.', 'invalid_assets', 'assets');
  if (keys.length > CLOUDFLARE_IMAGE_LIMITS.maxImages) {
    return fail(
      `assets must not contain more than ${CLOUDFLARE_IMAGE_LIMITS.maxImages} entries for this model.`,
      'too_many_assets',
      'assets',
    );
  }
  // Entries + Object.fromEntries, never value[key] = …: a '__proto__' key must stay an own key (CCR-6).
  const entries: [string, AssessmentAsset][] = [];
  let total = 0;
  for (const key of keys) {
    const at = `assets.${key}`;
    if (!ASSET_KEY_PATTERN.test(key)) {
      return fail('Asset keys must be 1-64 characters of letters, digits, "_" or "-".', 'invalid_asset_key', at);
    }
    const a = raw[key];
    if (!isPlainObject(a) || a.type !== 'image') {
      return fail(`${at} must be an object with type "image".`, 'invalid_asset', at);
    }
    const format = typeof a.format === 'string' ? a.format.toLowerCase() : '';
    if (!CLOUDFLARE_FORMATS.has(format)) {
      return fail(`${at}.format must be "png", "jpg", "jpeg" or "webp".`, 'unsupported_asset_format', `${at}.format`);
    }
    const data = a.data_base64;
    if (typeof data !== 'string' || data.length === 0 || !isStrictBase64(data)) {
      return fail(
        `${at}.data_base64 must be standard padded base64 with no "data:" prefix or whitespace.`,
        'invalid_asset_data',
        `${at}.data_base64`,
      );
    }
    if (!matchesSignature(format, data)) {
      return fail(`${at}.data_base64 is not a ${FORMAT_LABEL[format]} image.`, 'asset_format_mismatch', `${at}.data_base64`);
    }
    const bytes = decodedBase64Bytes(data);
    if (bytes > CLOUDFLARE_IMAGE_LIMITS.maxBytesEach) {
      return fail(`${at} must not exceed 4 MiB once decoded.`, 'asset_too_large', at);
    }
    total += bytes;
    entries.push([key, { type: 'image', format: format as AssessmentAsset['format'], data_base64: data }]);
  }
  if (total > CLOUDFLARE_IMAGE_LIMITS.maxBytesTotal) {
    return fail('assets must not exceed 8 MiB in total once decoded.', 'assets_too_large', 'assets');
  }
  return { ok: true, value: Object.fromEntries(entries) };
}

const CONTENT_TYPE: Record<string, CloudflareImage['content_type']> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

/** In Object.keys order (integer-like keys enumerate first, as JS does). Throws on a format the parser never admits. */
export function toCloudflareImages(assets: Record<string, AssessmentAsset>): CloudflareImage[] {
  return Object.keys(assets).map((key) => {
    const a = assets[key];
    const format = a.format.toLowerCase();
    // Own keys only: 'constructor' or 'toString' must throw too, not resolve off the prototype.
    const contentType = Object.hasOwn(CONTENT_TYPE, format) ? CONTENT_TYPE[format] : undefined;
    if (!contentType) throw new Error(`Unsupported image format: ${a.format}`);
    return { content_type: contentType, base64: a.data_base64 };
  });
}
