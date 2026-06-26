/**
 * Model catalog types + capability vocabulary, shared by server queries and
 * client components. Client-safe: NO server-only imports here (so a 'use client'
 * component can import MODEL_CAPABILITIES without pulling in the gateway SDK).
 *
 * Capabilities come from the AI Gateway's per-model `tags` (e.g. "vision",
 * "tool-use") — see lib/gateway/models.ts. `vision` means image *analysis*
 * (image input), distinct from `image-generation` (image output).
 */
export interface AvailableModel {
  id: string;
  name: string;
  provider: string;
  /** 'language' | 'image' | 'embedding' | 'reranking' | 'video' | … */
  type: string;
  contextWindow: number | null;
  maxTokens: number | null;
  /** USD per 1M tokens (derived from the gateway's per-token pricing). */
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  description: string | null;
  /** Raw capability tags from the gateway. */
  tags: string[];
}

/** The capabilities operators can filter on (a curated subset of the gateway tags). */
export const MODEL_CAPABILITIES = [
  { tag: 'image-generation', label: 'Image generation', hint: 'Generates images from a prompt' },
  { tag: 'vision', label: 'Image analysis', hint: 'Accepts image input' },
  { tag: 'file-input', label: 'File input', hint: 'Accepts PDF / document input' },
  { tag: 'tool-use', label: 'Tool use', hint: 'Function / tool calling' },
  { tag: 'reasoning', label: 'Reasoning', hint: 'Extended step-by-step reasoning' },
  { tag: 'web-search', label: 'Web search', hint: 'Built-in web search' },
] as const;

/** Friendly label for any tag (falls back to the raw tag, title-cased-ish). */
export function capabilityLabel(tag: string): string {
  const known = MODEL_CAPABILITIES.find((c) => c.tag === tag);
  if (known) return known.label;
  if (tag === 'implicit-caching' || tag === 'explicit-caching') return 'Prompt caching';
  return tag.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

/** True if the model carries every one of the given tags. */
export function modelHasAllTags(model: AvailableModel, tags: string[]): boolean {
  return tags.every((t) => model.tags.includes(t));
}
