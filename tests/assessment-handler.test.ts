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

import { APICallError, RetryError } from 'ai';
import {
  handleAssessment,
  withRetries,
  type ParsedAssessmentRequest,
} from '@/lib/gateway/assessments';

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
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** A fresh Response per call — a body can only be read once, and retries re-read. */
function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

const CTX = { keyId: 'key-1', gateway, model: MODEL, logContent: false };

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

  it('maps a 429 with its retry hint, after retrying it', async () => {
    vi.useFakeTimers();
    evaluate.mockImplementation(respond(429, { error: { message: 'slow down' } }));
    const pending = handleAssessment(CTX, parsed);
    await vi.advanceTimersByTimeAsync(6_000); // 2s + 4s of backoff
    const res = await pending;
    expect(res.status).toBe(429);
    expect(evaluate).toHaveBeenCalledTimes(3);
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

describe('handleAssessment — retries, mirroring the AI SDK', () => {
  it('absorbs a transient 503: one client 200, one ok usage row', async () => {
    vi.useFakeTimers();
    evaluate
      .mockImplementationOnce(respond(503, { error: { message: 'busy' } }))
      .mockImplementationOnce(respond(200, HAPPY));
    const pending = handleAssessment(CTX, parsed);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({ status: 'ok' });
  });

  it('gives up after 1 + 2 attempts and records one error row with the last status', async () => {
    vi.useFakeTimers();
    evaluate.mockImplementation(respond(503, { error: { message: 'busy' } }));
    const pending = handleAssessment(CTX, parsed);
    await vi.advanceTimersByTimeAsync(6_000);
    const res = await pending;

    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({
      status: 'error',
      errorMessage: 'upstream_http_503',
    });
  });

  it('backs off 2s, then 4s', async () => {
    vi.useFakeTimers();
    evaluate.mockImplementation(respond(503, {}));
    const pending = handleAssessment(CTX, parsed);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(evaluate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(evaluate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(evaluate).toHaveBeenCalledTimes(3);
    await pending;
  });

  it("honors a provider's retry-after when it is under a minute", async () => {
    vi.useFakeTimers();
    evaluate
      .mockImplementationOnce(respond(429, {}, { 'retry-after': '1' }))
      .mockImplementationOnce(respond(200, HAPPY));
    const pending = handleAssessment(CTX, parsed);

    await vi.advanceTimersByTimeAsync(999);
    expect(evaluate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 1s, not the 2s backoff
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect((await pending).status).toBe(200);
  });

  it.each([408, 409])('retries %i, which the SDK also treats as retryable', async (status) => {
    vi.useFakeTimers();
    evaluate.mockImplementationOnce(respond(status, {})).mockImplementationOnce(respond(200, HAPPY));
    const pending = handleAssessment(CTX, parsed);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).status).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 402, 422])('does not retry %i', async (status) => {
    evaluate.mockImplementation(respond(status, { error: { message: 'no' } }));
    await handleAssessment(CTX, parsed);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('hands a 401 to credential-health handling as the bare error, not a RetryError', async () => {
    evaluate.mockImplementation(respond(401, { error: { message: 'bad key' } }));
    await handleAssessment(CTX, parsed);
    const seen = mocks.normalizeProjectGatewayError.mock.calls[0][1];
    expect(APICallError.isInstance(seen)).toBe(true);
    expect(RetryError.isInstance(seen)).toBe(false);
  });

  it('retries a dropped connection (Node\'s "fetch failed" with a cause)', async () => {
    vi.useFakeTimers();
    evaluate
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }))
      .mockImplementationOnce(respond(200, HAPPY));
    const pending = handleAssessment(CTX, parsed);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).status).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('does not retry an arbitrary thrown error, matching the SDK', async () => {
    evaluate.mockRejectedValue(new Error('socket hang up'));
    await handleAssessment(CTX, parsed);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('does not retry the deadline firing', async () => {
    evaluate.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    await handleAssessment(CTX, parsed);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({ errorMessage: 'upstream_timeout' });
  });

  it('does not retry an unusable 200 body — that is not transient', async () => {
    evaluate.mockImplementation(respond(200, { answers: { refund: { type: 'histogram' } } }));
    const res = await handleAssessment(CTX, parsed);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('leaves no timer behind after a retried success', async () => {
    vi.useFakeTimers();
    evaluate.mockImplementationOnce(respond(503, {})).mockImplementationOnce(respond(200, HAPPY));
    const pending = handleAssessment(CTX, parsed);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withRetries', () => {
  it('stops waiting, releases its timer and rethrows when the deadline fires mid-backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      throw new APICallError({
        message: 'busy',
        url: 'https://example.test',
        requestBodyValues: {},
        statusCode: 503,
      });
    });
    const run = withRetries(attempt, controller.signal);
    const settled = run.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1_000); // inside the first 2s backoff
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    const error = (await settled) as Error;

    expect(error.name).toBe('TimeoutError');
    expect(attempt).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
