import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isKeyBindableType,
  keyModelsFromCatalog,
  listAllModels,
  modelSupportsBatchTranscription,
} from '@/lib/gateway/models';
import type { AvailableModel } from '@/lib/gateway/capabilities';

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

    await expect(listAllModels()).resolves.toHaveLength(1);
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
