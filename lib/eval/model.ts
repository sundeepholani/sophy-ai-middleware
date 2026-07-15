/**
 * Model handle for eval challenger/judge calls made from the cron. The caller
 * must supply the immutable project credential snapshot; there is deliberately
 * no global API-key or OIDC fallback.
 */
import type { ProjectGatewaySnapshot } from '@/lib/gateway/project-provider';

export function evalModel(gateway: ProjectGatewaySnapshot, modelId: string) {
  return gateway.gateway.languageModel(modelId);
}
