/**
 * Cloudflare Workers AI models Sophy serves (D4, D5). A static, CODE-REVIEWED
 * allowlist, deliberately not fetched: each entry needs bespoke request
 * translation (a body `selector`), a registry price for the monthly cap (D6), and
 * the upstream URL is built only from these ids (never from client input). This is
 * the one documented exception to lib/gateway/models.ts's "never hardcode model
 * slugs". Never add a Vercel AI Gateway slug here. Client-safe.
 *
 * Every price and limit was checked against Cloudflare's catalog API on
 * 2026-10-20 (models/search properties `price` and `context_window`).
 */
import type { AvailableModel } from '@/lib/gateway/capabilities';

/** Every Workers AI id Sophy serves starts with this. No Vercel id starts with '@' (477/477 checked). */
export const CLOUDFLARE_MODEL_PREFIX = '@cf/';
/** The value providerOf() returns, and the one stored in usage_events.provider and AvailableModel.provider. */
export const CLOUDFLARE_PROVIDER = 'cloudflare';

export type CloudflareModelId =
  | '@cf/cloudflare/clef'
  | '@cf/cloudflare/clef-flash'
  | '@cf/cloudflare/clef-omni'
  | '@cf/cloudflare/clairic';
export type CloudflareModelType = 'evaluation' | 'extraction';

export interface CloudflareModelEntry {
  /** The exact Workers AI id. Stored in api_keys.model, and the run-URL path suffix. */
  readonly id: CloudflareModelId;
  readonly name: string;
  readonly provider: 'cloudflare';
  readonly type: CloudflareModelType;
  /** Body `model` selector. Cloudflare 422s a selector that differs from the path model (cf-live/clef-path-flash-selector.*). */
  readonly selector: 'clef' | 'clef-flash' | 'clef-omni' | 'clairic';
  /** Tokens. Also the limit for the state pre-cap (image-assets / parsers). */
  readonly contextWindow: number;
  readonly maxTokens: null;
  /** USD per 1M input tokens, list price. */
  readonly inputPerMTok: number;
  /** Cloudflare bills no output tokens for these models: 0, not unknown. */
  readonly outputPerMTok: 0;
  readonly tags: readonly string[];
  readonly description: string;
  /** Research preview. True only for Clairic (D9). */
  readonly preview: boolean;
  readonly sourceUrl: string;
  readonly verifiedAt: '2026-10-20';
}

const DOCS = 'https://developers.cloudflare.com/workers-ai/models';

function entry(e: CloudflareModelEntry): CloudflareModelEntry {
  return Object.freeze({ ...e, tags: Object.freeze([...e.tags]) });
}

/** Frozen, in this order. Every entry has a finite price (fail-closed by construction, D6). */
export const CLOUDFLARE_MODELS: readonly CloudflareModelEntry[] = Object.freeze([
  entry({
    id: '@cf/cloudflare/clef', name: 'Clef', provider: 'cloudflare', type: 'evaluation', selector: 'clef',
    contextWindow: 65536, maxTokens: null, inputPerMTok: 0.24, outputPerMTok: 0,
    tags: ['evaluation', 'vision'], preview: false, sourceUrl: `${DOCS}/clef/`, verifiedAt: '2026-10-20',
    description:
      'Clef is a 27B multimodal decision model that turns a state and a schema of typed questions into decisions. It reads the state as text, JSON, images, or video, and returns a probability for every allowed option of every question. Sophy accepts text and images; video is not supported yet.',
  }),
  entry({
    id: '@cf/cloudflare/clef-flash', name: 'Clef Flash', provider: 'cloudflare', type: 'evaluation', selector: 'clef-flash',
    contextWindow: 24576, maxTokens: null, inputPerMTok: 0.038, outputPerMTok: 0,
    tags: ['evaluation', 'vision'], preview: false, sourceUrl: `${DOCS}/clef-flash/`, verifiedAt: '2026-10-20',
    description:
      'Clef-flash is a fast 9B multimodal decision model that turns a state and a schema of typed questions into decisions. It reads the state as text, JSON, images, or video, and returns a probability for every allowed option of every question. Sophy accepts text and images; video is not supported yet.',
  }),
  entry({
    id: '@cf/cloudflare/clef-omni', name: 'Clef Omni', provider: 'cloudflare', type: 'evaluation', selector: 'clef-omni',
    contextWindow: 65536, maxTokens: null, inputPerMTok: 0.15, outputPerMTok: 0,
    tags: ['evaluation', 'vision'], preview: false, sourceUrl: `${DOCS}/clef-omni/`, verifiedAt: '2026-10-20',
    description:
      'Clef-omni is a multimodal decision model built on a 30B-parameter mixture-of-experts (3B active) backbone. It turns a state and a schema of typed questions into decisions, reads the state as text, JSON, images, audio, or video, and returns a probability for every allowed option of every question. Sophy accepts text and images; audio and video are not supported yet.',
  }),
  entry({
    id: '@cf/cloudflare/clairic', name: 'Clairic', provider: 'cloudflare', type: 'extraction', selector: 'clairic',
    contextWindow: 65536, maxTokens: null, inputPerMTok: 0.1, outputPerMTok: 0,
    tags: ['extraction', 'vision'], preview: true, sourceUrl: `${DOCS}/clairic/`, verifiedAt: '2026-10-20',
    description:
      'Clairic is a System One-style model that can extract, compute, estimate, and forecast values from inputs. It is strongly typed and outputs confidence scores and probabilities against its outputs. This model is in early research preview from the Cloudflare Workers AI team. Research preview.',
  }),
]);

// A Map, not an object index: '__proto__' / 'constructor' must never resolve.
const BY_ID: ReadonlyMap<string, CloudflareModelEntry> = new Map(
  CLOUDFLARE_MODELS.map((m): [string, CloudflareModelEntry] => [m.id, m]),
);

/** Prefix test only. True for any '@cf/…' id, registered or not. Routing and fail-closed branches use it. */
export function isCloudflareModelId(model: string): boolean {
  return typeof model === 'string' && model.startsWith(CLOUDFLARE_MODEL_PREFIX);
}

/** Exact, case-sensitive registry lookup. No trimming, no normalisation. */
export function getCloudflareModel(model: string): CloudflareModelEntry | undefined {
  return typeof model === 'string' ? BY_ID.get(model) : undefined;
}

export class CloudflareModelNotRegisteredError extends Error {
  constructor(readonly model: string, readonly expectedType?: CloudflareModelType) {
    super(
      expectedType
        ? `Not a registered Cloudflare Workers AI ${expectedType} model.`
        : 'Not a registered Cloudflare Workers AI model.',
    );
    this.name = 'CloudflareModelNotRegisteredError';
  }
}

/** The registered entry of `type`, or throw CloudflareModelNotRegisteredError. Callers use it before any upstream call. */
export function requireCloudflareModel(model: string, type: CloudflareModelType): CloudflareModelEntry {
  const found = getCloudflareModel(model);
  if (!found || found.type !== type) throw new CloudflareModelNotRegisteredError(model, type);
  return found;
}

/** The catalog row. A fresh object (and tags array) on every call. */
export function cloudflareAvailableModel(e: CloudflareModelEntry): AvailableModel {
  return {
    id: e.id,
    name: e.name,
    provider: e.provider,
    type: e.type,
    contextWindow: e.contextWindow,
    maxTokens: null,
    inputPerMTok: e.inputPerMTok,
    outputPerMTok: 0,
    description: e.description,
    tags: [...e.tags],
    preview: e.preview,
  };
}

/** A fresh array on every call, in registry order. */
export function cloudflareAvailableModels(): AvailableModel[] {
  return CLOUDFLARE_MODELS.map(cloudflareAvailableModel);
}

/** Cloudflare's platform pre-check estimates tokens as compact input JSON length / 4 (cf-live/clef-flash-long.*). */
export const CLOUDFLARE_CHARS_PER_TOKEN_ESTIMATE = 4;

/** Math.ceil(JSON.stringify(inputWithoutImages).length / 4). The caller removes `images`; Cloudflare does not count base64 image bytes. */
export function cloudflareInputTokenEstimate(inputWithoutImages: unknown): number {
  return Math.ceil((JSON.stringify(inputWithoutImages) ?? '').length / CLOUDFLARE_CHARS_PER_TOKEN_ESTIMATE);
}
