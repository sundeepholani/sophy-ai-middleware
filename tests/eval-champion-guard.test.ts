import { describe, expect, it } from 'vitest';
import { evalChampionBlocked } from '@/lib/admin/keys';
import type { AvailableModel } from '@/lib/gateway/capabilities';

/**
 * Champion-vs-challenger eval compares text outputs, so only a language key can
 * be evaluated. This predicate is the single source both the console gate and
 * the server invariant in insertEvalRun call.
 */

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

const CATALOG = [
  model('openai/gpt-5-mini', 'language'),
  model('openai/gpt-4o-transcribe', 'transcription'),
  model('openai/text-embedding-3-small', 'embedding'),
  model('openai/gpt-image-1', 'image'),
  model('typesafe-ai/jev', 'evaluation'),
];

describe('evalChampionBlocked', () => {
  it('allows a catalogued language champion', () => {
    expect(evalChampionBlocked('openai/gpt-5-mini', CATALOG)).toBe(false);
  });

  it('blocks every other key-bindable type', () => {
    // All five types are bindable to a key (lib/gateway/models.ts), but only
    // `language` can be evaluated — lib/eval/model.ts builds a languageModel.
    for (const id of [
      'openai/gpt-4o-transcribe',
      'openai/text-embedding-3-small',
      'openai/gpt-image-1',
    ]) {
      expect(evalChampionBlocked(id, CATALOG)).toBe(true);
    }
  });

  it('blocks an evaluation champion, which /v1/evaluate serves and generateText does not', () => {
    // Called out separately: `evaluation` became key-bindable when /v1/evaluate
    // shipped, which is exactly the case a denylist would have missed.
    expect(evalChampionBlocked('typesafe-ai/jev', CATALOG)).toBe(true);
  });

  it('fails open for an id the catalog does not list', () => {
    // Custom / private / stale model ids stay allowed, matching the sibling
    // transcript-processor rule in the same module.
    expect(evalChampionBlocked('private/custom-model', CATALOG)).toBe(false);
  });

  it('fails open when the catalog is unavailable', () => {
    // Both callers pass [] after a catalog fetch failure.
    expect(evalChampionBlocked('openai/gpt-4o-transcribe', [])).toBe(false);
  });
});
