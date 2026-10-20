import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isKeyBindableType,
  keyModelsFromCatalog,
  listAllModels,
  modelSupportsBatchTranscription,
} from '@/lib/gateway/models';
import { MODEL_CAPABILITIES, type AvailableModel } from '@/lib/gateway/capabilities';
import { CLOUDFLARE_MODELS, cloudflareAvailableModels } from '@/lib/gateway/cloudflare-models';

afterEach(() => vi.unstubAllGlobals());

describe('public gateway model catalog', () => {
  it('never sends a project or platform Authorization header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has('authorization')).toBe(false);
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-5-mini',
              name: 'GPT-5 mini',
              owned_by: 'openai',
              type: 'language',
              tags: [],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAllModels()).resolves.toHaveLength(1 + CLOUDFLARE_MODELS.length);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function model(id: string, type: string, tags: string[] = []): AvailableModel {
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
    tags,
  };
}

describe('key model catalog', () => {
  it('offers batch transcription models but excludes realtime-only socket models', () => {
    expect(modelSupportsBatchTranscription(model('openai/gpt-4o-transcribe', 'transcription'))).toBe(
      true,
    );
    expect(
      modelSupportsBatchTranscription(
        model('openai/gpt-realtime-whisper', 'transcription', [
          'websocket-realtime',
          'websocket-transcription',
        ]),
      ),
    ).toBe(false);
    // Some batch-capable models advertise an additional socket mode.
    expect(
      modelSupportsBatchTranscription(
        model('xai/grok-stt', 'transcription', ['websocket-transcription']),
      ),
    ).toBe(true);
  });

  it('keeps language first and admits only supported key surfaces', () => {
    const result = keyModelsFromCatalog([
      model('openai/gpt-image-1', 'image'),
      model('typesafe-ai/jev', 'evaluation'),
      model('openai/gpt-4o-transcribe', 'transcription'),
      model('openai/text-embedding-3-small', 'embedding'),
      model('openai/gpt-5-mini', 'language'),
      model('cohere/rerank-v4', 'reranking'),
      model('elevenlabs/tts', 'speech'),
      model('alibaba/wan-v3.0-video', 'video'),
      model('openai/gpt-realtime-whisper', 'transcription', ['websocket-realtime']),
    ]);

    expect(result.map((candidate) => candidate.id)).toEqual([
      'openai/gpt-5-mini',
      'openai/gpt-4o-transcribe',
      'openai/text-embedding-3-small',
      'openai/gpt-image-1',
      'typesafe-ai/jev',
    ]);
  });

  // Regression lock: an evaluation model was invisible in the key picker until
  // /v1/evaluate existed to serve it. Keep this and the route set in step.
  it('offers evaluation models to a key now that /v1/evaluate serves them', () => {
    expect(isKeyBindableType('evaluation')).toBe(true);
    expect(keyModelsFromCatalog([model('typesafe-ai/jev', 'evaluation')])).toHaveLength(1);
  });

  it('still refuses model types no route can serve', () => {
    for (const type of ['reranking', 'speech', 'video', 'realtime']) {
      expect(isKeyBindableType(type)).toBe(false);
      expect(keyModelsFromCatalog([model(`vendor/${type}`, type)])).toHaveLength(0);
    }
  });
});

describe('evaluation model normalization', () => {
  it("synthesizes an 'evaluation' capability for a model the gateway ships untagged", async () => {
    // Jev's catalog entry has no `tags` key at all, no max_tokens and a zero
    // output price. Without the synthetic tag it renders as '—' and is
    // invisible to the capability filter. Fresh module: the catalog memoizes
    // for an hour, so a second listAllModels() in this file would be cached.
    vi.resetModules();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'typesafe-ai/jev',
                name: 'Jev',
                owned_by: 'typesafe-ai',
                type: 'evaluation',
                context_window: 32000,
                max_tokens: 0,
                pricing: { input: '0.000000042', output: '0' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const fresh = await import('@/lib/gateway/models');
    const [jev] = await fresh.listAllModels();

    expect(jev.tags).toEqual(['evaluation']);
    expect(jev.type).toBe('evaluation');
    expect(jev.maxTokens).toBe(0); // 0, not null — the model emits no tokens
    expect(jev.outputPerMTok).toBe(0); // free output, not unknown
    expect(jev.inputPerMTok).toBeCloseTo(0.042, 6);
    expect(fresh.keyModelsFromCatalog([jev])).toHaveLength(1);
  });
});

describe('Cloudflare Workers AI registry in the catalog', () => {
  /** A fresh module per case: the catalog memoizes for an hour. */
  async function freshCatalog(data: unknown[]) {
    vi.resetModules();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const fresh = await import('@/lib/gateway/models');
    return fresh.listAllModels();
  }

  it('appends the Cloudflare registry after the sorted gateway rows', async () => {
    const all = await freshCatalog([
      { id: 'b/model', type: 'language' },
      { id: 'a/model', type: 'language' },
    ]);

    expect(all.map((m) => m.id)).toEqual([
      'a/model',
      'b/model',
      ...CLOUDFLARE_MODELS.map((m) => m.id),
    ]);
    const registryRows = all.slice(2);
    expect(registryRows).toEqual(cloudflareAvailableModels());
    expect(registryRows.map((m) => m.preview)).toEqual(CLOUDFLARE_MODELS.map((m) => m.preview));
    expect(registryRows.every((m) => m.provider === 'cloudflare')).toBe(true);
  });

  it('drops @cf/ rows the gateway lists', async () => {
    const all = await freshCatalog([
      { id: 'b/model', type: 'language' },
      { id: '@cf/cloudflare/clef', pricing: { input: '0.000009' } },
      { id: '@cf/other/x' },
    ]);

    const clef = all.filter((m) => m.id === '@cf/cloudflare/clef');
    expect(clef).toHaveLength(1);
    expect(clef[0]).toMatchObject({ inputPerMTok: 0.24, type: 'evaluation', provider: 'cloudflare' });
    expect(all.some((m) => m.id === '@cf/other/x')).toBe(false);
    expect(all).toHaveLength(1 + CLOUDFLARE_MODELS.length);
  });

  it('offers Clef as evaluation and Clairic as extraction', () => {
    const result = keyModelsFromCatalog([
      model('openai/gpt-5-mini', 'language'),
      model('typesafe-ai/jev', 'evaluation'),
      ...cloudflareAvailableModels(),
    ]);

    expect(result.map((m) => m.type)).toEqual([
      'language',
      'evaluation',
      'evaluation',
      'evaluation',
      'evaluation',
      'extraction',
    ]);
    // Display order only: '@cf/' sorts before 'typesafe-ai/' under localeCompare.
    expect(result.map((m) => m.id)).toEqual([
      'openai/gpt-5-mini',
      '@cf/cloudflare/clef',
      '@cf/cloudflare/clef-flash',
      '@cf/cloudflare/clef-omni',
      'typesafe-ai/jev',
      '@cf/cloudflare/clairic',
    ]);
    expect(isKeyBindableType('extraction')).toBe(true);
    // Every registry tag is a curated capability, so the Models filter offers it.
    expect(MODEL_CAPABILITIES.find((c) => c.tag === 'extraction')).toEqual({
      tag: 'extraction',
      label: 'Extraction',
      hint: 'Extracts typed values from text and images',
    });
    for (const tag of CLOUDFLARE_MODELS.flatMap((m) => m.tags)) {
      expect(MODEL_CAPABILITIES.map((c) => c.tag as string)).toContain(tag);
    }
  });
});
