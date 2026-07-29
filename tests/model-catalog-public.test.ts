import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
      model('openai/gpt-4o-transcribe', 'transcription'),
      model('openai/text-embedding-3-small', 'embedding'),
      model('openai/gpt-5-mini', 'language'),
      model('cohere/rerank-v4', 'reranking'),
      model('openai/gpt-realtime-whisper', 'transcription', ['websocket-realtime']),
    ]);

    expect(result.map((candidate) => candidate.id)).toEqual([
      'openai/gpt-5-mini',
      'openai/gpt-4o-transcribe',
      'openai/text-embedding-3-small',
      'openai/gpt-image-1',
    ]);
  });
});
