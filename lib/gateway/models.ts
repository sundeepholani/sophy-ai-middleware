/**
 * Lists models available through the AI Gateway, with capabilities.
 *
 * We hit the gateway's raw OpenAI-compatible models endpoint (public) rather
 * than the AI SDK's getAvailableModels(), because the SDK helper drops the
 * per-model `tags` (vision, tool-use, …), context window, and pricing — which
 * we need for the Models screen and the capability filter. Never hardcode model
 * slugs; versions use dots (e.g. "anthropic/claude-sonnet-4.6").
 */
import type { AvailableModel } from '@/lib/gateway/capabilities';

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
const CATALOG_TTL_MS = 60 * 60 * 1000;
let catalog: { at: number; data: AvailableModel[] } | null = null;

async function fetchCatalog(): Promise<AvailableModel[]> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.data;
  try {
    const data = await fetchFresh();
    catalog = { at: Date.now(), data };
    return data;
  } catch (err) {
    if (catalog) return catalog.data; // serve stale on a transient gateway blip
    throw err;
  }
}

/** Every model in the catalog (all types), for the Models reference screen. */
export async function listAllModels(): Promise<AvailableModel[]> {
  return fetchCatalog();
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
 * `/v1/responses`), image (`/v1/images/generations`), and embedding
 * (`/v1/embeddings`). Reranking/video models aren't served by a key. Language
 * models sort first so creating a new key still defaults to a chat model.
 */
const KEY_MODEL_TYPE_ORDER: Record<string, number> = { language: 0, embedding: 1, image: 2 };

export async function listKeyModels(): Promise<AvailableModel[]> {
  const all = await fetchCatalog();
  return all
    .filter((m) => m.type in KEY_MODEL_TYPE_ORDER)
    .sort((a, b) =>
      a.type === b.type
        ? a.id.localeCompare(b.id)
        : KEY_MODEL_TYPE_ORDER[a.type] - KEY_MODEL_TYPE_ORDER[b.type],
    );
}
