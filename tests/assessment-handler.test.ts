import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGatewaySnapshot } from '@/lib/gateway/project-provider';

const mocks = vi.hoisted(() => ({
  // Declared via the generic form, not an implementation with an unused param:
  // it keeps `mock.calls[0][0]` addressable under --noEmit without tripping
  // no-unused-vars (whose default `after-used` would flag a trailing arg).
  recordUsage: vi.fn<(input: unknown) => Promise<void>>(),
  recordAssessmentLog: vi.fn<(input: unknown) => Promise<void>>(),
  normalizeProjectGatewayError: vi.fn(async (_snapshot: unknown, error: unknown) => error),
}));

vi.mock('@/lib/usage/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/usage/record')>()),
  recordUsage: mocks.recordUsage,
  recordAssessmentLog: mocks.recordAssessmentLog,
}));
vi.mock('@/lib/gateway/project-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/project-provider')>()),
  normalizeProjectGatewayError: mocks.normalizeProjectGatewayError,
}));

import { handleAssessment, type ParsedAssessmentRequest } from '@/lib/gateway/assessments';

const MODEL = 'typesafe-ai/jev';

const evaluate = vi.fn();
const gateway = {
  projectId: '00000000-0000-4000-8000-000000000001',
  gatewayCredentialId: '00000000-0000-4000-8000-000000000002',
  credentialRevision: 1,
  source: 'encrypted_api_key',
  evaluator: { evaluate },
} as unknown as ProjectGatewaySnapshot;

const parsed: ParsedAssessmentRequest = {
  state: 'I was charged twice for my subscription.',
  questions: { refund: { type: 'boolean', instructions: 'Is a refund requested?' } },
  providerOptions: {},
};

function upstreamOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const HAPPY = {
  model: MODEL,
  answers: { refund: { type: 'boolean', probability: 0.98 } },
  usage: { inputTokens: 275, outputTokens: 20 },
  providerMetadata: {
    gateway: { cost: '0.00001155', generationId: 'gen_abc' },
  },
};

beforeEach(() => {
  evaluate.mockReset();
  mocks.recordUsage.mockClear();
  mocks.recordAssessmentLog.mockClear();
  mocks.normalizeProjectGatewayError.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('handleAssessment — happy path', () => {
  it('posts the key model plus state and questions, and returns only the mapped payload', async () => {
    evaluate.mockResolvedValue(upstreamOk(HAPPY));

    const res = await handleAssessment(
      { keyId: 'key-1', gateway, model: MODEL, logContent: false },
      parsed,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({
      model: MODEL,
      answers: { refund: { type: 'boolean', probability: 0.98 } },
      usage: { inputTokens: 275, outputTokens: 20, totalTokens: 295 },
    });

    expect(evaluate).toHaveBeenCalledOnce();
    const [sentBody, signal] = evaluate.mock.calls[0];
    expect(sentBody).toEqual({
      model: MODEL,
      state: parsed.state,
      questions: parsed.questions,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('omits providerOptions from the upstream body when the client sent none', async () => {
    evaluate.mockResolvedValue(upstreamOk(HAPPY));
    await handleAssessment({ keyId: 'key-1', gateway, model: MODEL, logContent: false }, parsed);
    expect(evaluate.mock.calls[0][0]).not.toHaveProperty('providerOptions');
  });

  it('forwards providerOptions when the client sent them', async () => {
    evaluate.mockResolvedValue(upstreamOk(HAPPY));
    await handleAssessment(
      { keyId: 'key-1', gateway, model: MODEL, logContent: false },
      { ...parsed, providerOptions: { 'typesafe-ai': { zeroDataRetention: true } } },
    );
    expect(evaluate.mock.calls[0][0]).toMatchObject({
      providerOptions: { 'typesafe-ai': { zeroDataRetention: true } },
    });
  });

  it('records usage with the gateway cost, the shared event id and the assessment kind', async () => {
    evaluate.mockResolvedValue(upstreamOk(HAPPY));
    await handleAssessment({ keyId: 'key-1', gateway, model: MODEL, logContent: false }, parsed);

    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({
      projectId: gateway.projectId,
      gatewayCredentialId: gateway.gatewayCredentialId,
      keyId: 'key-1',
      provider: 'typesafe-ai',
      model: MODEL,
      status: 'ok',
      responseKind: 'assessment',
      costUsd: 0.00001155,
      gatewayRequestId: 'gen_abc',
      usage: expect.objectContaining({ inputTokens: 275, outputTokens: 20, totalTokens: 295 }),
    });
  });
});

describe('handleAssessment — content logging', () => {
  it('does not log content when the key opted out', async () => {
    evaluate.mockResolvedValue(upstreamOk(HAPPY));
    await handleAssessment({ keyId: 'key-1', gateway, model: MODEL, logContent: false }, parsed);
    expect(mocks.recordAssessmentLog).not.toHaveBeenCalled();
  });

  it('logs state, questions and answers under the usage event id when the key opted in', async () => {
    evaluate.mockResolvedValue(upstreamOk(HAPPY));
    await handleAssessment({ keyId: 'key-1', gateway, model: MODEL, logContent: true }, parsed);

    expect(mocks.recordAssessmentLog).toHaveBeenCalledOnce();
    const logged = mocks.recordAssessmentLog.mock.calls[0][0] as Record<string, unknown>;
    expect(logged).toMatchObject({
      projectId: gateway.projectId,
      keyId: 'key-1',
      state: parsed.state,
      questions: parsed.questions,
      status: 'ok',
      answers: { refund: { type: 'boolean', probability: 0.98 } },
    });
    // The request log joins usage_events on a shared id.
    expect(logged.id).toBe((mocks.recordUsage.mock.calls[0][0] as { id: string }).id);
  });

  it('writes the usage row before the request log (request_logs has the FK)', async () => {
    evaluate.mockResolvedValue(upstreamOk(HAPPY));
    const order: string[] = [];
    mocks.recordUsage.mockImplementationOnce(async () => {
      order.push('usage');
    });
    mocks.recordAssessmentLog.mockImplementationOnce(async () => {
      order.push('log');
    });
    await handleAssessment({ keyId: 'key-1', gateway, model: MODEL, logContent: true }, parsed);
    expect(order).toEqual(['usage', 'log']);
  });
});

describe('handleAssessment — upstream failures', () => {
  it('maps a non-2xx upstream status instead of a blanket 502', async () => {
    evaluate.mockResolvedValue(
      upstreamOk({ error: { message: 'Bad evaluation request.' } }, 400),
    );
    const res = await handleAssessment(
      { keyId: 'key-1', gateway, model: MODEL, logContent: false },
      parsed,
    );
    expect(res.status).toBe(400);
  });

  it('maps a 429 with its retry hint', async () => {
    evaluate.mockResolvedValue(upstreamOk({ error: { message: 'slow down' } }, 429));
    const res = await handleAssessment(
      { keyId: 'key-1', gateway, model: MODEL, logContent: false },
      parsed,
    );
    expect(res.status).toBe(429);
  });

  it('turns an unusable 200 body into a failure rather than a partial success', async () => {
    evaluate.mockResolvedValue(upstreamOk({ answers: { refund: { type: 'histogram' } } }));
    const res = await handleAssessment(
      { keyId: 'key-1', gateway, model: MODEL, logContent: false },
      parsed,
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('turns malformed JSON on a 200 into a failure, not an unhandled throw', async () => {
    evaluate.mockResolvedValue(
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const res = await handleAssessment(
      { keyId: 'key-1', gateway, model: MODEL, logContent: false },
      parsed,
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('records an error usage row and an error log on failure', async () => {
    evaluate.mockRejectedValue(new Error('socket hang up'));
    await handleAssessment({ keyId: 'key-1', gateway, model: MODEL, logContent: true }, parsed);

    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({
      status: 'error',
      responseKind: 'assessment',
      usage: expect.objectContaining({ inputTokens: 0, outputTokens: 0 }),
    });
    expect(mocks.recordAssessmentLog.mock.calls[0][0]).toMatchObject({
      status: 'error',
      answers: null,
    });
  });

  it('routes the failure through the project credential-health normalizer', async () => {
    evaluate.mockResolvedValue(upstreamOk({ error: { message: 'no' } }, 401));
    await handleAssessment({ keyId: 'key-1', gateway, model: MODEL, logContent: false }, parsed);
    expect(mocks.normalizeProjectGatewayError).toHaveBeenCalledOnce();
  });

  it('never puts client state or questions in the upstream error payload', async () => {
    evaluate.mockResolvedValue(upstreamOk({ error: { message: 'Bad request.' } }, 400));
    const res = await handleAssessment(
      { keyId: 'key-1', gateway, model: MODEL, logContent: false },
      parsed,
    );
    const text = await res.text();
    expect(text).not.toContain('charged twice');
    expect(text).not.toContain('Is a refund requested?');
  });
});
