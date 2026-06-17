/**
 * Lists the language models available through the AI Gateway, for the admin
 * route editor. Never hardcode model slugs — they change and versions use dots
 * (e.g. "anthropic/claude-sonnet-4.6").
 */
import { gateway } from '@ai-sdk/gateway';

export interface AvailableModel {
  id: string;
  name: string;
  provider: string;
}

export async function listGatewayModels(): Promise<AvailableModel[]> {
  const res = await gateway.getAvailableModels();
  return res.models
    .filter((m) => m.modelType == null || m.modelType === 'language')
    .map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.specification.provider,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
