/**
 * Lists models available through the AI Gateway, with capabilities.
 *
 * We hit the gateway's raw OpenAI-compatible models endpoint (public) rather
 * than the AI SDK's getAvailableModels(), because the SDK helper drops the
 * per-model `tags` (vision, tool-use, …), context window, and pricing — which
 * we need for the Models screen and the capability filter. Never hardcode model
 * slugs; versions use dots (e.g. "anthropic/claude-sonnet-4.6").
 */
import { env } from '@/lib/env';
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
  if (rate == null) return null;
  const n = Number(rate);
  return Number.isFinite(n) ? n * 1_000_000 : null;
}

async function fetchCatalog(): Promise<AvailableModel[]> {
  const headers: Record<string, string> = {};
  // The list is public, but sending the gateway key when present avoids any
  // unauthenticated rate limiting. OIDC (request path) also works unauthenticated.
  const apiKey = env.aiGatewayApiKey();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(GATEWAY_MODELS_URL, {
    headers,
    signal: AbortSignal.timeout(10_000),
    // The catalog changes infrequently — cache it for an hour across requests.
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`gateway models request failed: ${res.status}`);
  const json = (await res.json()) as { data?: RawGatewayModel[]; models?: RawGatewayModel[] };
  const raw = json.data ?? json.models ?? [];

  return raw
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: m.owned_by ?? m.id.split('/')[0] ?? 'unknown',
      type: m.type ?? 'language',
      contextWindow: m.context_window ?? null,
      maxTokens: m.max_tokens ?? null,
      inputPerMTok: perMillion(m.pricing?.input),
      outputPerMTok: perMillion(m.pricing?.output),
      description: m.description ?? null,
      tags: Array.isArray(m.tags) ? m.tags : [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every model in the catalog (all types), for the Models reference screen. */
export async function listAllModels(): Promise<AvailableModel[]> {
  return fetchCatalog();
}

/**
 * Language models only — for the key route editor / model picker, since the
 * proxy serves text+vision→text chat (image-generation/embedding models aren't
 * routable here).
 */
export async function listGatewayModels(): Promise<AvailableModel[]> {
  const all = await fetchCatalog();
  return all.filter((m) => m.type === 'language');
}
