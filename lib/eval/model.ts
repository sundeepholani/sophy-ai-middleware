/**
 * Model handle for eval (challenger + judge) calls made from the cron.
 *
 * Live request handlers authenticate to the AI Gateway via the request-scoped
 * Vercel OIDC token, but the cron is not a user request — its build-time OIDC
 * token can be expired. So when AI_GATEWAY_API_KEY is set we use an explicit
 * gateway credential; otherwise we fall back to the default provider (OIDC),
 * which works locally where a fresh token is present.
 */
import { createGateway } from '@ai-sdk/gateway';
import { env } from '@/lib/env';

let cached: ReturnType<typeof createGateway> | undefined;

export function evalModel(modelId: string) {
  const apiKey = env.aiGatewayApiKey();
  if (!apiKey) return modelId; // default provider (request-scoped OIDC)
  if (!cached) cached = createGateway({ apiKey });
  return cached(modelId);
}
