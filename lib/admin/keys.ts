import type { AvailableModel } from '@/lib/gateway/capabilities';

export interface TranscriptProcessorSelection {
  primaryModel: AvailableModel | undefined;
  systemPrompt: string;
  transcriptProcessorModel: string;
  models: AvailableModel[];
}

/**
 * Validate the cross-model rule for batch transcription keys.
 *
 * Native speech-to-text prompts only guide recognition; they cannot reliably
 * perform arbitrary operator-requested work on the transcript. A transcription
 * key with a system prompt therefore needs a separate language model. Unknown
 * processor ids remain allowed, matching Sophy's stale/custom primary-model
 * behavior, but a catalog model positively known to be non-language is rejected.
 */
export function transcriptProcessorSelectionError({
  primaryModel,
  systemPrompt,
  transcriptProcessorModel,
  models,
}: TranscriptProcessorSelection): string | null {
  if (primaryModel?.type !== 'transcription') return null;

  const processor = transcriptProcessorModel.trim();
  if (systemPrompt.trim() && !processor) {
    return 'Choose a transcript processor model when a transcription key has a system prompt.';
  }
  if (!processor) return null;

  const knownProcessor = models.find((model) => model.id === processor);
  if (knownProcessor && knownProcessor.type !== 'language') {
    return 'Transcript processor must be a language model.';
  }
  return null;
}
