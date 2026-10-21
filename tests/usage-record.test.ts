import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));

import {
  recordAssessmentLog,
  recordExtractionLog,
  recordUsage,
  recordUsageBatch,
  toAssessmentLogRequest,
  toExtractionLogRequest,
  ZERO_USAGE,
  type RecordUsageInput,
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

describe('credential attribution (exactly one paying credential)', () => {
  const PROJECT = '00000000-0000-4000-8000-000000000001';
  const ROW_A = '00000000-0000-4000-8000-000000000002';
  const GW = '00000000-0000-4000-8000-000000000004';
  const KEY = '00000000-0000-4000-8000-000000000003';

  it('attributes a Cloudflare call to the Cloudflare credential only', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockReturnValue({ insert: vi.fn(() => ({ values })) });

    await recordUsage({
      projectId: PROJECT,
      cloudflareCredentialId: ROW_A,
      keyId: KEY,
      provider: 'cloudflare',
      model: '@cf/cloudflare/clef',
      usage: { ...ZERO_USAGE, inputTokens: 222, totalTokens: 222 },
      costUsd: 0.000008,
      status: 'ok',
      responseKind: 'assessment',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudflareCredentialId: ROW_A,
        gatewayCredentialId: null,
        provider: 'cloudflare',
        costUsd: '0.000008',
      }),
    );
  });

  it('keeps Vercel attribution unchanged', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockReturnValue({ insert: vi.fn(() => ({ values })) });

    await recordUsage({
      projectId: PROJECT,
      gatewayCredentialId: GW,
      keyId: KEY,
      provider: 'openai',
      model: 'openai/example',
      usage: { ...ZERO_USAGE },
      status: 'ok',
      responseKind: 'text',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayCredentialId: GW, cloudflareCredentialId: null }),
    );
  });

  it('rejects ambiguous attribution at compile time', () => {
    // pnpm typecheck enforces the two @ts-expect-error lines; running them is harmless.
    const check = (i: RecordUsageInput) => i;
    const base = { projectId: PROJECT, keyId: KEY, usage: { ...ZERO_USAGE }, status: 'ok' as const };

    expect(check({ ...base, gatewayCredentialId: GW })).toMatchObject({ gatewayCredentialId: GW });
    expect(check({ ...base, cloudflareCredentialId: ROW_A })).toMatchObject({
      cloudflareCredentialId: ROW_A,
    });
    // @ts-expect-error both credentials paid: the union forbids it (D7)
    check({ ...base, gatewayCredentialId: GW, cloudflareCredentialId: ROW_A });
    // @ts-expect-error no credential paid: one of the two is required
    check({ ...base });
  });
});

describe('extraction request log', () => {
  const ID = '00000000-0000-4000-8000-000000000011';
  const PROJECT = '00000000-0000-4000-8000-000000000001';
  const KEY = '00000000-0000-4000-8000-000000000003';
  const state = 'Invoice INV-7731. Total due: $1,287.50 by 29 Oct.';
  const fields = {
    total: { type: 'number', instructions: 'Amount due' },
    due_date: { type: 'date' },
  };

  function insertRecorder() {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    mocks.getDb.mockReturnValue({ insert });
    return { insert, values, onConflictDoNothing };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shapes the extraction request log', () => {
    expect(
      toExtractionLogRequest({
        state,
        fields,
        assets: { scan: { format: 'png', bytes: 1234 } },
        referenceDate: '2026-10-20',
        options: { return_state_text: true },
      }),
    ).toEqual({
      state,
      fields,
      assets: { scan: { format: 'png', bytes: 1234 } },
      reference_date: '2026-10-20',
      options: { return_state_text: true },
    });
    // Nothing optional was sent → no optional keys at all.
    expect(toExtractionLogRequest({ state, fields })).toEqual({ state, fields });
  });

  it('never logs image bytes or unknown options', () => {
    const shaped = toExtractionLogRequest({
      state,
      fields,
      assets: { scan: { format: 'png', bytes: 3, data_base64: 'QUJD' } } as never,
      options: { include_quantiles: true, evil: 1 } as never,
    });
    const serialized = JSON.stringify(shaped);

    expect(serialized).not.toContain('data_base64');
    expect(serialized).not.toContain('QUJD');
    expect(serialized).not.toContain('evil');
    expect(shaped).toMatchObject({
      assets: { scan: { format: 'png', bytes: 3 } },
      options: { include_quantiles: true },
    });
    expect(toExtractionLogRequest({ state, fields, options: {} })).not.toHaveProperty('options');
  });

  it('truncates an oversized extraction request', () => {
    const shaped = toExtractionLogRequest({ state: 'x'.repeat(100_001), fields }) as {
      truncated?: boolean;
      preview?: string;
    };

    expect(shaped.truncated).toBe(true);
    expect(shaped.preview).toHaveLength(100_000);
  });

  it('inserts an extraction log without state_text', async () => {
    const { values, onConflictDoNothing } = insertRecorder();
    const answers = { total: { type: 'number', value: 1287.5 } };

    await recordExtractionLog({
      id: ID,
      projectId: PROJECT,
      keyId: KEY,
      state,
      fields,
      assets: { scan: { format: 'png', bytes: 1234 } },
      answers,
      truncated: false,
      status: 'ok',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID,
        projectId: PROJECT,
        apiKeyId: KEY,
        surface: 'extraction',
        systemPrompt: null,
        streamed: false,
        status: 'ok',
        request: { state, fields, assets: { scan: { format: 'png', bytes: 1234 } } },
        response: JSON.stringify({ answers, truncated: false }, null, 2),
      }),
    );
    expect(onConflictDoNothing).toHaveBeenCalledOnce();

    await recordExtractionLog({
      id: ID,
      projectId: PROJECT,
      keyId: KEY,
      state,
      fields,
      answers: null,
      status: 'error',
    });

    expect(values).toHaveBeenLastCalledWith(expect.objectContaining({ response: null, status: 'error' }));
    expect(JSON.stringify(values.mock.calls)).not.toContain('state_text');
  });

  it('swallows extraction log failures without echoing the driver error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const driverError = new Error('Failed query: insert into "request_logs" … params: SECRET');
    // Both ways a failed insert can surface: thrown while building, or rejected on await.
    const failures = [
      { insert: vi.fn(() => { throw driverError; }) },
      {
        insert: vi.fn(() => ({
          values: () => ({ onConflictDoNothing: () => Promise.reject(driverError) }),
        })),
      },
    ];

    for (const db of failures) {
      consoleError.mockClear();
      mocks.getDb.mockReturnValue(db);

      await expect(
        recordExtractionLog({
          id: ID,
          projectId: PROJECT,
          keyId: KEY,
          state: 'SECRET state',
          fields,
          answers: null,
          status: 'error',
        }),
      ).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError.mock.calls[0]).toEqual(['[request-log] failed to insert extraction request_log']);
    }
  });

  it('swallows assessment log failures without echoing the driver error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const driverError = new Error('Failed query: insert into "request_logs" … params: SECRET state');
    mocks.getDb.mockReturnValue({ insert: vi.fn(() => { throw driverError; }) });

    await expect(
      recordAssessmentLog({
        id: ID,
        projectId: PROJECT,
        keyId: KEY,
        state: 'SECRET state',
        questions: { refund: { type: 'boolean', instructions: 'Refund asked?' } },
        answers: null,
        status: 'error',
      }),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]).toEqual(['[request-log] failed to insert assessment request_log']);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('SECRET');
  });
});
