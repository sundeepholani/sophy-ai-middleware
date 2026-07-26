import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));

import { recordUsage, ZERO_USAGE } from '@/lib/usage/record';

afterEach(() => {
  vi.clearAllMocks();
});

describe('recordUsage cache-write telemetry', () => {
  it('persists a reported cache-write count', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockReturnValue({ insert: vi.fn(() => ({ values })) });

    await recordUsage({
      projectId: '00000000-0000-4000-8000-000000000001',
      gatewayCredentialId: '00000000-0000-4000-8000-000000000002',
      keyId: '00000000-0000-4000-8000-000000000003',
      provider: 'openai',
      model: 'openai/example',
      usage: { ...ZERO_USAGE, cacheWriteTokens: 42 },
      status: 'ok',
      responseKind: 'text',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheWriteTokens: 42,
      }),
    );
  });

  it('persists null when cache writes were not reported', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockReturnValue({ insert: vi.fn(() => ({ values })) });

    await recordUsage({
      projectId: '00000000-0000-4000-8000-000000000001',
      gatewayCredentialId: '00000000-0000-4000-8000-000000000002',
      keyId: null,
      usage: { ...ZERO_USAGE },
      status: 'ok',
      responseKind: 'embedding',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheWriteTokens: null,
      }),
    );
  });
});
