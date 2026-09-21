/**
 * Lists models available through the AI Gateway, with capabilities.
 *
 * We hit the gateway's raw OpenAI-compatible models endpoint (public) rather
 * than the AI SDK's getAvailableModels(), because the SDK helper drops the
 * per-model `tags` (vision, tool-use, …), context window, and pricing — which
 * we need for the Models screen and the capability filter. Never hardcode model
 * slugs; versions use dots (e.g. "anthropic/claude-sonnet-4.6").
 */
import { modelSupportsLanguage, type AvailableModel } from '@/lib/gateway/capabilities';

export type { AvailableModel } from '@/lib/gateway/capabilities';

const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';

interface RawGatewayModel {
  id: string;
  name?: string;
  owned_by?: string;
  type?: string;
  context_window?: number | null;
  max_tokens?: number | null;
  description?: string | null;
  tags?: string[];
  pricing?: { input?: string; output?: string } | null;
}

function perMillion(rate: string | undefined): number | null {
  if (rate == null || rate.trim() === '') return null; // unknown ≠ free($0)
  const n = Number(rate);
  return Number.isFinite(n) ? n * 1_000_000 : null;
}

async function fetchFresh(): Promise<AvailableModel[]> {
  const res = await fetch(GATEWAY_MODELS_URL, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`gateway models request failed: ${res.status}`);
  const json = (await res.json()) as { data?: RawGatewayModel[]; models?: RawGatewayModel[] };
  const raw = json.data ?? json.models ?? [];

  return raw
    .map((m) => {
      const type = m.type ?? 'language';
      const tags = Array.isArray(m.tags) ? [...m.tags] : [];
      // The gateway flags image models via `type`, not a tag. Surface a synthetic
      // `image-generation` capability so the capability filter and Models screen
      // treat it like any other capability.
      if (type === 'image' && !tags.includes('image-generation')) tags.push('image-generation');
      // Same for evaluation models: the gateway flags them via `type` and ships
      // them with no tags at all, which would otherwise render them as '—' and
      // make them invisible to the capability filter.
      if (type === 'evaluation' && !tags.includes('evaluation')) tags.push('evaluation');
      return {
        id: m.id,
        name: m.name ?? m.id,
        provider: m.owned_by ?? m.id.split('/')[0] ?? 'unknown',
        type,
        contextWindow: m.context_window ?? null,
        maxTokens: m.max_tokens ?? null,
        inputPerMTok: perMillion(m.pricing?.input),
        outputPerMTok: perMillion(m.pricing?.output),
        description: m.description ?? null,
        tags,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Module-level cache: the admin pages that read the catalog are force-dynamic,
// which disables Next's fetch Data Cache — so we memoize here instead. The
// catalog changes infrequently; a warm instance reuses it for an hour, and a
// transient gateway failure falls back to the last good copy rather than throwing.
//
// The chat and responses surfaces now consult this on every request (see
// languageCapability), so a cold or degraded instance must not multiply the
// load: `inflight` collapses concurrent callers onto one fetch, and a failure
// with a stale copy re-stamps the memo so a broken endpoint is retried on a
// timer rather than by every request that arrives behind the 10s timeout.
const CATALOG_TTL_MS = 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 30 * 1000;
let catalog: { at: number; data: AvailableModel[] } | null = null;
let inflight: Promise<AvailableModel[]> | null = null;

async function fetchCatalog(): Promise<AvailableModel[]> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.data;
  inflight ??= fetchFresh()
    .then((data) => {
      catalog = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  try {
    return await inflight;
  } catch (err) {
    if (catalog) {
      // Serve stale on a transient gateway blip, but back off: without this the
      // memo stays expired and every subsequent request re-attempts the fetch.
      catalog.at = Date.now() - CATALOG_TTL_MS + RETRY_AFTER_FAILURE_MS;
      return catalog.data;
    }
    throw err;
  }
}

/** Every model in the catalog (all types), for the Models reference screen. */
export async function listAllModels(): Promise<AvailableModel[]> {
  return fetchCatalog();
}

/**
 * The catalog lookup behind every surface's capability guard. Fail-open by
 * construction: an unreachable catalog or an id the catalog does not list both
 * return 'unknown', so a guard never blocks a request it cannot classify.
 *
 * The lookup races a short timer because the language surfaces call this on the
 * hot path — fetchFresh allows itself 10s, which must never become chat's TTFB.
 * A fetch that loses the race still populates the memo for the next request.
 */
const CAPABILITY_LOOKUP_MS = 1_500;

export async function catalogCapability(
  model: string,
  supports: (candidate: AvailableModel) => boolean,
): Promise<'supported' | 'unsupported' | 'unknown'> {
  let all: AvailableModel[] | null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    all = await Promise.race([
      listAllModels(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CAPABILITY_LOOKUP_MS);
      }),
    ]);
  } catch {
    return 'unknown';
  } finally {
    // The race settles on whichever side wins but stops neither. With a warm
    // memo the catalog wins at once on nearly every request, so without this
    // each guarded request would leave a live 1.5s timer behind.
    clearTimeout(timer);
  }
  if (!all) return 'unknown';
  const candidate = all.find((item) => item.id === model);
  if (!candidate) return 'unknown';
  return supports(candidate) ? 'supported' : 'unsupported';
}

/**
 * Classify a key's model for the chat/responses surfaces. Every surface guard —
 * this one, transcription, embeddings, image and assessment — goes through
 * catalogCapability, so they share one fail-open policy and one time bound.
 */
export async function languageCapability(
  model: string,
): Promise<'language' | 'not_language' | 'unknown'> {
  const result = await catalogCapability(model, modelSupportsLanguage);
  return result === 'supported' ? 'language' : result === 'unsupported' ? 'not_language' : 'unknown';
}

/**
 * Language models only — for the eval challenger / judge pickers, which compare
 * text outputs and must never offer image/embedding models.
 */
export async function listGatewayModels(): Promise<AvailableModel[]> {
  const all = await fetchCatalog();
  return all.filter((m) => m.type === 'language');
}

/**
 * Models a Sophy key can be bound to: language (chat/`/v1/chat/completions` +
 * `/v1/responses`), transcription (`/v1/audio/transcriptions`), image
 * (`/v1/images/generations`), embedding (`/v1/embeddings`), and evaluation
 * (`/v1/evaluate`). Reranking/speech/video/realtime models aren't served by a
 * key — there is no route for them, so offering one would create a binding the
 * proxy cannot honor. Keep this map and the route set in step. Language models
 * sort first so creating a new key still defaults to a chat model.
 */
const KEY_MODEL_TYPE_ORDER: Record<string, number> = {
  language: 0,
  transcription: 1,
  embedding: 2,
  image: 3,
  evaluation: 4,
};

/** Pure: can a Sophy key be bound to this catalog type at all? */
export function isKeyBindableType(type: string): boolean {
  return type in KEY_MODEL_TYPE_ORDER;
}

/**
 * The file-upload transcription route is a buffered/batch surface. Gateway
 * models marked `websocket-realtime` require a live WebSocket session and must
 * not be offered for that route. `websocket-transcription` alone is not an
 * exclusion: some batch-capable models also advertise an optional socket mode.
 */
export function modelSupportsBatchTranscription(model: AvailableModel): boolean {
  return model.type === 'transcription' && !model.tags.includes('websocket-realtime');
}

/** Pure catalog filter/sort used by the loader and focused tests. */
export function keyModelsFromCatalog(all: AvailableModel[]): AvailableModel[] {
  return all
    .filter(
      (model) =>
        model.type in KEY_MODEL_TYPE_ORDER &&
        (model.type !== 'transcription' || modelSupportsBatchTranscription(model)),
    )
    .sort((a, b) =>
      a.type === b.type
        ? a.id.localeCompare(b.id)
        : KEY_MODEL_TYPE_ORDER[a.type] - KEY_MODEL_TYPE_ORDER[b.type],
    );
}

export async function listKeyModels(): Promise<AvailableModel[]> {
  const all = await fetchCatalog();
  return keyModelsFromCatalog(all);
}
