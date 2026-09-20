import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelSupportsLanguage, type AvailableModel } from '@/lib/gateway/capabilities';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function model(id: string, type: string): AvailableModel {
  return {
    id,
    name: id,
    provider: id.split('/')[0] ?? 'test',
    type,
    contextWindow: null,
    maxTokens: null,
    inputPerMTok: null,
    outputPerMTok: null,
    description: null,
    tags: [],
  };
}

/** A fresh module instance, so the 1-hour catalog memo never leaks between cases. */
async function freshModels(payload: unknown[], opts: { fail?: boolean } = {}) {
  vi.resetModules();
  const fetchMock = vi.fn(async () => {
    if (opts.fail) throw new Error('gateway down');
    return new Response(JSON.stringify({ data: payload }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { mod: await import('@/lib/gateway/models'), fetchMock };
}

describe('modelSupportsLanguage', () => {
  it('accepts only the language catalog type', () => {
    expect(modelSupportsLanguage(model('openai/gpt-5-mini', 'language'))).toBe(true);
    for (const type of ['transcription', 'embedding', 'image', 'reranking', 'speech', 'video']) {
      expect(modelSupportsLanguage(model(`vendor/${type}`, type))).toBe(false);
    }
  });

  it('excludes evaluation models, which are key-bindable but not chat models', () => {
    // An allowlist, not a denylist: `evaluation` became bindable when
    // /v1/evaluate shipped, and a denylist would have silently admitted it.
    expect(modelSupportsLanguage(model('typesafe-ai/jev', 'evaluation'))).toBe(false);
  });
});

describe('languageCapability', () => {
  it('classifies a catalogued language model', async () => {
    const { mod } = await freshModels([{ id: 'openai/gpt-5-mini', type: 'language' }]);
    await expect(mod.languageCapability('openai/gpt-5-mini')).resolves.toBe('language');
  });

  it('classifies a catalogued non-language model', async () => {
    const { mod } = await freshModels([{ id: 'typesafe-ai/jev', type: 'evaluation' }]);
    await expect(mod.languageCapability('typesafe-ai/jev')).resolves.toBe('not_language');
  });

  it("fails open to 'unknown' for an id the catalog does not list", async () => {
    const { mod } = await freshModels([{ id: 'openai/gpt-5-mini', type: 'language' }]);
    await expect(mod.languageCapability('private/custom-model')).resolves.toBe('unknown');
  });

  it("fails open to 'unknown' when the catalog is unreachable and nothing is memoized", async () => {
    const { mod } = await freshModels([], { fail: true });
    await expect(mod.languageCapability('openai/gpt-5-mini')).resolves.toBe('unknown');
  });

  it("treats a catalog entry with no type as language (models.ts defaults it)", async () => {
    const { mod } = await freshModels([{ id: 'vendor/untyped' }]);
    await expect(mod.languageCapability('vendor/untyped')).resolves.toBe('language');
  });
});

describe('catalogCapability — shared by every surface guard', () => {
  it('reports unsupported only on a positive classification', async () => {
    const { mod } = await freshModels([
      { id: 'openai/gpt-5-mini', type: 'language' },
      { id: 'openai/gpt-image-1', type: 'image' },
    ]);
    const isImage = (m: AvailableModel) => m.type === 'image';
    await expect(mod.catalogCapability('openai/gpt-image-1', isImage)).resolves.toBe('supported');
    await expect(mod.catalogCapability('openai/gpt-5-mini', isImage)).resolves.toBe('unsupported');
    await expect(mod.catalogCapability('nope/nope', isImage)).resolves.toBe('unknown');
  });

  it("gives up with 'unknown' rather than letting a slow catalog become chat's TTFB", async () => {
    vi.resetModules();
    // A fetch that never settles: the guard must not wait on it.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const mod = await import('@/lib/gateway/models');

    const started = Date.now();
    await expect(mod.languageCapability('openai/gpt-5-mini')).resolves.toBe('unknown');
    // Comfortably under fetchFresh's own 10s AbortSignal.timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
