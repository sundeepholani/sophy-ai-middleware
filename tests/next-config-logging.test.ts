import { describe, expect, it } from 'vitest';
import nextConfig from '@/next.config';

/**
 * `next dev` prints every Server Function call with its arguments unless
 * logging.serverFunctions is false (Next's default is true; see
 * node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/logging.md).
 * The credential cards call connectProjectCloudflare({ projectId, accountId, apiToken }) and
 * connectProjectGateway({ projectId, apiKey }) with the secret as a plain argument, so the
 * default would write a plaintext token to the terminal whenever an Admin connects or rotates.
 */
describe('next.config logging', () => {
  it('never logs Server Function arguments in development', () => {
    const { logging } = nextConfig;
    // `logging: false` silences all development logging, which also covers this.
    const logsServerFunctions = logging !== false && (logging?.serverFunctions ?? true);
    expect(logsServerFunctions).toBe(false);
  });

  it('keeps incoming-request logging at its default', () => {
    expect(nextConfig.logging).not.toBe(false);
    if (nextConfig.logging) expect(nextConfig.logging.incomingRequests).toBeUndefined();
  });
});
