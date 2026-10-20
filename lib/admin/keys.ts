import type { AvailableModel } from '@/lib/gateway/capabilities';
import { getCloudflareModel, isCloudflareModelId } from '@/lib/gateway/cloudflare-models';

/** Thrown for an '@cf/' id outside the registry (D4). Already user-facing; the CLI passes it
 *  through as a 400 invalid_request. */
export const UNSUPPORTED_CLOUDFLARE_MODEL = 'Unsupported Cloudflare Workers AI model';
/** Thrown code when the project's Cloudflare credential is not ready (D3). The CLI maps it to 409. */
export const CLOUDFLARE_NOT_READY = 'cloudflare_not_ready';

/**
 * Bind-time rule for Workers AI ids (D3, D4). Null for every non-'@cf/' id, so Vercel ids keep their
 * fail-open catalog behaviour. Detection tolerates surrounding whitespace, but the registry lookup is
 * exact and case-sensitive: '@cf/cloudflare/clef ' or '@cf/Cloudflare/Clef' is unsupported instead of
 * being stored and then failing closed at request time.
 */
export function cloudflareBindingError(model: string, cloudflareReady: boolean): string | null {
  if (!isCloudflareModelId(model.trim())) return null;
  if (!getCloudflareModel(model)) return UNSUPPORTED_CLOUDFLARE_MODEL;
  return cloudflareReady ? null : CLOUDFLARE_NOT_READY;
}

/**
 * The Keys form's mirror of createKey / updateKey. The registry rule always applies. The readiness
 * rule applies on create, or on an edit that changes the model, so renaming an existing Clef key
 * while Cloudflare is down stays allowed. `initialModel` is null in create mode.
 */
export function keyFormCloudflareError(input: {
  model: string;
  initialModel: string | null;
  cloudflareReady: boolean;
}): string | null {
  const model = input.model.trim();
  const bindingChanges = input.initialModel === null || model !== input.initialModel;
  return cloudflareBindingError(model, input.cloudflareReady || !bindingChanges);
}

/** Model-picker labels: a provider hint that also flags a missing credential, plus 'Preview' for
 *  research previews (D9). Empty for every non-registry id. */
export function cloudflareModelBadges(model: string, cloudflareReady: boolean): string[] {
  const entry = getCloudflareModel(model);
  if (!entry) return [];
  const badges = [cloudflareReady ? 'Cloudflare' : 'Needs Cloudflare'];
  if (entry.preview) badges.push('Preview');
  return badges;
}

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
 * Workers AI ids ('@cf/…') are never language models, so they are rejected even
 * when the catalog does not list them.
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

  // Registered or not, a Workers AI id serves /v1/evaluate or /v1/extract and never
  // generates text, so it fails closed without the catalog. Unknown non-'@cf/' ids
  // stay allowed below.
  if (isCloudflareModelId(processor)) return 'Transcript processor must be a language model.';
  const knownProcessor = models.find((model) => model.id === processor);
  if (knownProcessor && knownProcessor.type !== 'language') {
    return 'Transcript processor must be a language model.';
  }
  return null;
}

/**
 * Champion-vs-challenger eval compares TEXT outputs — lib/eval/model.ts builds
 * a `languageModel` and lib/eval/process.ts calls `generateText` — so only a
 * language key can be evaluated. Unknown / uncatalogued ids stay allowed,
 * matching Sophy's stale-model behavior and the sibling rule above.
 *
 * An allowlist on `language`, not a denylist of the other types: the set of
 * key-bindable types grows (evaluation was added when /v1/evaluate shipped),
 * and a denylist would silently admit each new one.
 *
 * Workers AI ids ('@cf/…') are blocked first: they serve /v1/evaluate and
 * /v1/extract and never generate text. The prefix alone classifies them, so
 * this also holds during a catalog outage.
 */
export function evalChampionBlocked(model: string, models: AvailableModel[]): boolean {
  if (isCloudflareModelId(model)) return true;
  const known = models.find((candidate) => candidate.id === model);
  return !!known && known.type !== 'language';
}
