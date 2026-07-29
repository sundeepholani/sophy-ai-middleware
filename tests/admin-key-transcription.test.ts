import { describe, expect, it } from 'vitest';
import { transcriptProcessorSelectionError } from '@/lib/admin/keys';
import type { AvailableModel } from '@/lib/gateway/capabilities';

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

const transcription = model('openai/gpt-4o-transcribe', 'transcription');
const language = model('openai/gpt-5-mini', 'language');
const image = model('openai/gpt-image-1', 'image');
const models = [transcription, language, image];

describe('transcript processor key configuration', () => {
  it('requires a processor when a transcription key has a system prompt', () => {
    expect(
      transcriptProcessorSelectionError({
        primaryModel: transcription,
        systemPrompt: 'Translate the transcript into English.',
        transcriptProcessorModel: '',
        models,
      }),
    ).toContain('Choose a transcript processor');
  });

  it('allows raw transcription with no system prompt or processor', () => {
    expect(
      transcriptProcessorSelectionError({
        primaryModel: transcription,
        systemPrompt: '   ',
        transcriptProcessorModel: '',
        models,
      }),
    ).toBeNull();
  });

  it('accepts a language processor and rejects a known non-language processor', () => {
    expect(
      transcriptProcessorSelectionError({
        primaryModel: transcription,
        systemPrompt: 'Summarize the transcript.',
        transcriptProcessorModel: language.id,
        models,
      }),
    ).toBeNull();
    expect(
      transcriptProcessorSelectionError({
        primaryModel: transcription,
        systemPrompt: 'Summarize the transcript.',
        transcriptProcessorModel: image.id,
        models,
      }),
    ).toBe('Transcript processor must be a language model.');
  });

  it('does not apply transcription-only rules to other key types', () => {
    expect(
      transcriptProcessorSelectionError({
        primaryModel: language,
        systemPrompt: 'Answer concisely.',
        transcriptProcessorModel: '',
        models,
      }),
    ).toBeNull();
  });

  it('preserves Sophy custom/stale model behavior for an unknown processor id', () => {
    expect(
      transcriptProcessorSelectionError({
        primaryModel: transcription,
        systemPrompt: 'Clean up the transcript.',
        transcriptProcessorModel: 'vendor/custom-language-model',
        models,
      }),
    ).toBeNull();
  });
});
