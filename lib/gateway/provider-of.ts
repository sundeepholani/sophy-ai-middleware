import { CLOUDFLARE_PROVIDER, isCloudflareModelId } from '@/lib/gateway/cloudflare-models';

/**
 * The provider namespace of a key model id: '@cf/…' → 'cloudflare' (D4); otherwise
 * the first path segment, unchanged (byte-identical to the old inline copies).
 */
export function providerOf(model: string): string {
  return isCloudflareModelId(model) ? CLOUDFLARE_PROVIDER : (model.split('/')[0] ?? 'unknown');
}
