import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));

import {
  recordUsage,
  recordUsageBatch,
  toAssessmentLogRequest,
  ZERO_USAGE,
} from '@/lib/usage/record';

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

  it('inserts all model components for one request in a single statement', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockReturnValue({ insert: vi.fn(() => ({ values })) });

    await recordUsageBatch([
      {
        id: '00000000-0000-4000-8000-000000000011',
        projectId: '00000000-0000-4000-8000-000000000001',
        gatewayCredentialId: '00000000-0000-4000-8000-000000000002',
        keyId: '00000000-0000-4000-8000-000000000003',
        source: 'proxy',
        model: 'openai/gpt-4o-mini-transcribe',
        usage: { ...ZERO_USAGE },
        status: 'ok',
        responseKind: 'transcription',
      },
      {
        id: '00000000-0000-4000-8000-000000000012',
        projectId: '00000000-0000-4000-8000-000000000001',
        gatewayCredentialId: '00000000-0000-4000-8000-000000000002',
        keyId: '00000000-0000-4000-8000-000000000003',
        source: 'transcript_processor',
        model: 'anthropic/claude-sonnet-4.5',
        usage: { ...ZERO_USAGE, inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        status: 'ok',
        responseKind: 'transcription',
      },
    ]);

    expect(values).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'proxy',
        model: 'openai/gpt-4o-mini-transcribe',
      }),
      expect.objectContaining({
        source: 'transcript_processor',
        model: 'anthropic/claude-sonnet-4.5',
        inputTokens: 20,
        outputTokens: 5,
      }),
    ]);
  });
});

describe('assessment usage and logging', () => {
  it("records an evaluation call under the 'assessment' response kind", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockReturnValue({ insert: vi.fn(() => ({ values })) });

    await recordUsage({
      projectId: '00000000-0000-4000-8000-000000000001',
      gatewayCredentialId: '00000000-0000-4000-8000-000000000002',
      keyId: '00000000-0000-4000-8000-000000000003',
      provider: 'typesafe-ai',
      model: 'typesafe-ai/jev',
      usage: { ...ZERO_USAGE, inputTokens: 275, outputTokens: 20, totalTokens: 295 },
      costUsd: 0.00001155,
      status: 'ok',
      responseKind: 'assessment',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        responseKind: 'assessment',
        model: 'typesafe-ai/jev',
        inputTokens: 275,
        outputTokens: 20,
      }),
    );
  });

  it('shapes the state and questions for the request log', () => {
    const state = { order: { id: 'A-1' } };
    const questions = { refund: { type: 'boolean', instructions: 'Refund asked?' } };
    expect(toAssessmentLogRequest({ state, questions })).toEqual({ state, questions });
  });

  it('truncates an oversized state instead of storing it whole', () => {
    const shaped = toAssessmentLogRequest({
      state: 'x'.repeat(150_000),
      questions: { a: { type: 'boolean', instructions: 'ok?' } },
    }) as { truncated?: boolean; preview?: string };

    expect(shaped.truncated).toBe(true);
    expect(shaped.preview).toHaveLength(100_000);
  });
});
