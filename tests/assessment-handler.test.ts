import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGatewaySnapshot } from '@/lib/gateway/project-provider';
import type { ProjectCloudflareSnapshot } from '@/lib/gateway/cloudflare-provider';
import type { AssessmentAsset } from '@/lib/http/openai';

const mocks = vi.hoisted(() => ({
  // Declared via the generic form, not an implementation with an unused param:
  // it keeps `mock.calls[0][0]` addressable under --noEmit without tripping
  // no-unused-vars (whose default `after-used` would flag a trailing arg).
  recordUsage: vi.fn<(input: unknown) => Promise<void>>(),
  recordAssessmentLog: vi.fn<(input: unknown) => Promise<void>>(),
  normalizeProjectGatewayError: vi.fn(async (_snapshot: unknown, error: unknown) => error),
  // The real one CAS-writes the Cloudflare row (Phase A's tests cover that).
  // Here, a fake applies Phase A's pure classifier with no DB (set in beforeEach).
  normalizeProjectCloudflareError: vi.fn<(snapshot: unknown, error: unknown) => Promise<unknown>>(),
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
vi.mock('@/lib/gateway/cloudflare-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/cloudflare-provider')>()),
  normalizeProjectCloudflareError: mocks.normalizeProjectCloudflareError,
}));

import { APICallError, RetryError } from 'ai';
import {
  handleAssessment,
  withRetries,
  type ParsedAssessmentRequest,
} from '@/lib/gateway/assessments';
import { cloudflareCredentialFailure } from '@/lib/gateway/cloudflare-call';
import { ProjectCloudflareUnavailableError } from '@/lib/gateway/project-provider';

const MODEL = 'typesafe-ai/jev';

const evaluate = vi.fn();
const systemOneWithImages = vi.fn();
const gateway = {
  projectId: '00000000-0000-4000-8000-000000000001',
  gatewayCredentialId: '00000000-0000-4000-8000-000000000002',
  credentialRevision: 1,
  source: 'encrypted_api_key',
  evaluator: { evaluate, systemOneWithImages },
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

// ---- Cloudflare Workers AI (Clef) fixtures ------------------------------------

const CF_MODEL = '@cf/cloudflare/clef-flash';
const CLEF = '@cf/cloudflare/clef';
const CLAIRIC = '@cf/cloudflare/clairic';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
/** The project's Cloudflare runner. Phase A's real callCloudflareModel and withRetries run on top of it. */
const run = vi.fn<(model: string, body: unknown, signal: AbortSignal) => Promise<Response>>();
const cloudflare: ProjectCloudflareSnapshot = {
  projectId: '00000000-0000-4000-8000-000000000001',
  cloudflareCredentialId: '00000000-0000-4000-8000-000000000004',
  credentialRevision: 1,
  accountId: ACCOUNT_ID,
  runner: { run },
};
const CF_CTX = { keyId: 'key-1', cloudflare, model: CF_MODEL, logContent: false };

/** The live probe's success body (clef-flash, 222 input tokens). */
const CF_RESULT = {
  model: 'clef-flash',
  answers: { refund: { type: 'noul', noul: 0.9584 } },
  usage: { input_tokens: 222, output_tokens: 0 },
};
const REQ_ID = 'ce8c7745-ca64-4a50-98f2-6b2189c48a3f';
// cf-ai-neurons 10 → $0.00011, deliberately unlike the token fallback (222 × $0.038/M → $0.000008).
const CF_HEADERS = { 'cf-ai-neurons': '10', 'cf-ai-req-id': REQ_ID, 'cf-ray': 'a4d766322e1ba01b-FRA' };

const UPSTREAM_502 = {
  error: {
    message: 'The evaluation request failed.',
    type: 'api_error',
    param: null,
    code: 'upstream_error',
  },
};
const NEUTRAL_503 = {
  error: {
    message:
      'This project is not ready to make AI requests. Ask a project admin to connect or check its AI provider credentials.',
    type: 'api_error',
    param: null,
    code: 'project_gateway_unavailable',
  },
};

/** Fresh v4-envelope Responses per call: a body can only be read once, and retries re-read. */
function cfOk(result: unknown, headers: Record<string, string> = {}) {
  return async () =>
    new Response(JSON.stringify({ result, success: true, errors: [], messages: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
}
function cfErr(status: number, code: number, message: string, headers: Record<string, string> = {}) {
  return async () =>
    new Response(
      JSON.stringify({ result: null, success: false, errors: [{ code, message }], messages: [] }),
      { status, headers: { 'content-type': 'application/json', ...headers } },
    );
}
/** A billed 200 whose body is still streaming when `signal` aborts; the read then fails with the abort reason. */
function stalledSuccess(signal: AbortSignal, headers: Record<string, string>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"result":{"model":"clef-flash"'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json', ...headers } },
  );
}
const usageRow = () => mocks.recordUsage.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  evaluate.mockReset();
  systemOneWithImages.mockReset();
  mocks.recordUsage.mockClear();
  mocks.recordAssessmentLog.mockClear();
  mocks.normalizeProjectGatewayError.mockClear();
  run.mockReset();
  mocks.normalizeProjectCloudflareError.mockReset();
  mocks.normalizeProjectCloudflareError.mockImplementation(async (snapshot, error) => {
    const s = snapshot as ProjectCloudflareSnapshot;
    return cloudflareCredentialFailure(error) === 'invalid'
      ? new ProjectCloudflareUnavailableError(s.projectId, 'credential_invalid', s.cloudflareCredentialId, error)
      : error;
  });
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
    expect(mocks.recordUsage.mock.calls[0][0]).not.toHaveProperty('cloudflareCredentialId');
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
    expect(mocks.normalizeProjectCloudflareError).not.toHaveBeenCalled();
  });

  it('keeps the gateway error row free of Cloudflare attribution, request id and cost', async () => {
    evaluate.mockResolvedValue(upstreamOk({ error: { message: 'Bad request.' } }, 400));
    await handleAssessment(CTX, parsed);
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    const row = mocks.recordUsage.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toMatchObject({
      projectId: gateway.projectId,
      gatewayCredentialId: gateway.gatewayCredentialId,
      provider: 'typesafe-ai',
      status: 'error',
      errorMessage: 'upstream_http_400',
    });
    expect(row).not.toHaveProperty('cloudflareCredentialId');
    expect(row).not.toHaveProperty('gatewayRequestId');
    expect(row).not.toHaveProperty('costUsd');
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

describe('handleAssessment — image assets', () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const withImage: ParsedAssessmentRequest = {
    state: { photo: 'selfie-1' },
    questions: { groomed: { type: 'boolean', instructions: 'Is the person in `photo` groomed?' } },
    providerOptions: {},
    assets: { 'selfie-1': { type: 'image', format: 'png', data_base64: PNG_B64 } },
  };
  const TYPESAFE_OK = {
    model: MODEL,
    answers: { groomed: { type: 'noul', noul: 0.91 } },
    usage: { input_tokens: 655, output_tokens: 62 },
    provider_metadata: { gateway: { cost: '0.00002751', generationId: 'gen_img' } },
  };

  it('routes to the TypeSafe endpoint in its shape and maps the answer back', async () => {
    systemOneWithImages.mockResolvedValue(upstreamOk(TYPESAFE_OK));
    const res = await handleAssessment(
      { keyId: 'key-1', gateway, model: MODEL, logContent: false },
      withImage,
    );

    expect(evaluate).not.toHaveBeenCalled();
    expect(systemOneWithImages.mock.calls[0][0]).toEqual({
      model: MODEL,
      state: withImage.state,
      questions: { groomed: { type: 'noul', instructions: 'Is the person in `photo` groomed?' } },
      assets: withImage.assets,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      model: MODEL,
      answers: { groomed: { type: 'boolean', probability: 0.91 } },
      usage: { inputTokens: 655, outputTokens: 62, totalTokens: 717 },
    });
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({
      status: 'ok',
      costUsd: 0.00002751,
      gatewayRequestId: 'gen_img',
      usage: expect.objectContaining({ inputTokens: 655, outputTokens: 62 }),
    });
  });

  it('logs the image format and size, never its bytes', async () => {
    systemOneWithImages.mockResolvedValue(upstreamOk(TYPESAFE_OK));
    await handleAssessment({ keyId: 'key-1', gateway, model: MODEL, logContent: true }, withImage);
    const logged = mocks.recordAssessmentLog.mock.calls[0][0] as Record<string, unknown>;
    expect(logged.assets).toEqual({
      'selfie-1': { format: 'png', bytes: Buffer.from(PNG_B64, 'base64').length },
    });
    expect(JSON.stringify(logged)).not.toContain(PNG_B64);
  });

  it("surfaces TypeSafe's 400 message (e.g. image too small) as a client error", async () => {
    systemOneWithImages.mockImplementation(
      respond(400, {
        message: 'Image selfie-1 is 1x1; each side must be between 280 and 1568 pixels.',
        error_type: 'invalid_request',
      }),
    );
    const res = await handleAssessment(
      { keyId: 'key-1', gateway, model: MODEL, logContent: false },
      withImage,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe('upstream_invalid_request');
    expect(body.error.message).toContain('280 and 1568');
    expect(systemOneWithImages).toHaveBeenCalledOnce();
  });
});

describe('handleAssessment — Cloudflare Clef', () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  /** 34 bytes: 'RIFF' + size + 'WEBP' + 'VP8L…'. */
  const WEBP_B64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
  const img = (format: AssessmentAsset['format'], data_base64: string): AssessmentAsset => ({
    type: 'image',
    format,
    data_base64,
  });

  /** cf-live/clef-text (key @cf/cloudflare/clef), inlined: the probe scratchpad may vanish. */
  const CLEF_TEXT_PARSED: ParsedAssessmentRequest = {
    state:
      'Support ticket #4821 from a retail customer: our checkout page has returned HTTP 500 errors for every customer since 09:10 UTC. We are losing roughly $2,000 per minute in sales. Please escalate immediately.',
    questions: {
      urgent: {
        type: 'boolean',
        instructions: 'Is this support request urgent?',
        criteria: { true: 'Needs action within the hour', false: 'Can wait in the normal queue' },
      },
      team: {
        type: 'choice',
        instructions: 'Which team should handle this request?',
        criteria: {
          billing: 'Payments, invoices, and refunds',
          technical: 'Outages, errors, and configuration',
          sales: 'Plans and upgrades',
        },
      },
      severity: {
        type: 'score',
        instructions: 'How severe is the customer impact?',
        criteria: ['No impact', 'Minor', 'Major', 'Critical'],
      },
    },
    providerOptions: {},
  };
  const CLEF_TEXT_RESULT = {
    model: 'clef',
    answers: {
      urgent: { type: 'noul', noul: 0.8998 },
      team: {
        type: 'choice',
        choice: 'technical',
        probabilities: { billing: 0.0605, technical: 0.931, sales: 0.0085 },
        confidence: 0.8058,
      },
      severity: {
        type: 'score',
        score: 2.9603,
        legend: { '0': 'No impact', '1': 'Minor', '2': 'Major', '3': 'Critical' },
        probabilities: { '0': 0.0035, '1': 0.0035, '2': 0.0222, '3': 0.9708 },
        confidence: 0.9239,
      },
    },
    usage: { input_tokens: 381, output_tokens: 0 },
  };

  it("posts the registry selector and System One questions through the project's Cloudflare runner", async () => {
    run.mockImplementation(cfOk(CF_RESULT, CF_HEADERS));
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
    const [model, sent, signal] = run.mock.calls[0];
    expect(model).toBe(CF_MODEL);
    expect(sent).toEqual({
      model: 'clef-flash',
      state: parsed.state,
      questions: { refund: { type: 'noul', instructions: 'Is a refund requested?' } },
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(evaluate).not.toHaveBeenCalled();
    expect(systemOneWithImages).not.toHaveBeenCalled();
  });

  it("returns only the mapped payload under the key's model", async () => {
    run.mockImplementation(cfOk(CF_RESULT, CF_HEADERS));
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      model: CF_MODEL,
      answers: { refund: { type: 'boolean', probability: 0.9584 } },
      usage: { inputTokens: 222, outputTokens: 0, totalTokens: 222 },
    });
    expect(text).not.toContain(REQ_ID);
    expect(text).not.toContain(ACCOUNT_ID);
  });

  it('records one ok usage row paid by the Cloudflare credential, costed from cf-ai-neurons', async () => {
    run.mockImplementation(cfOk(CF_RESULT, CF_HEADERS));
    await handleAssessment(CF_CTX, parsed);

    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      projectId: cloudflare.projectId,
      cloudflareCredentialId: cloudflare.cloudflareCredentialId,
      keyId: 'key-1',
      provider: 'cloudflare',
      model: CF_MODEL,
      status: 'ok',
      responseKind: 'assessment',
      costUsd: 0.00011,
      gatewayRequestId: REQ_ID,
      usage: expect.objectContaining({ inputTokens: 222, outputTokens: 0, totalTokens: 222 }),
    });
    expect(usageRow()).not.toHaveProperty('gatewayCredentialId');
  });

  it('falls back to registry token pricing and to cf-ray when Cloudflare sends no neurons or request id', async () => {
    run.mockImplementation(
      cfOk(
        { ...CF_RESULT, model: 'clef', usage: { input_tokens: 381, output_tokens: 0 } },
        { 'cf-ray': 'a4d766322e1ba01b-FRA' },
      ),
    );
    await handleAssessment({ ...CF_CTX, model: CLEF }, parsed);

    expect(run.mock.calls[0][1]).toMatchObject({ model: 'clef' });
    // 381 × $0.24/M = $0.00009144 → 0.000091.
    expect(usageRow()).toMatchObject({ costUsd: 0.000091, gatewayRequestId: 'a4d766322e1ba01b-FRA' });
  });

  it('maps a live Clef result end to end, keeping confidence and dropping legend', async () => {
    run.mockImplementation(cfOk(CLEF_TEXT_RESULT));
    const res = await handleAssessment({ ...CF_CTX, model: CLEF }, CLEF_TEXT_PARSED);

    expect(run.mock.calls[0][1]).toMatchObject({ model: 'clef', questions: { urgent: { type: 'noul' } } });
    await expect(res.json()).resolves.toEqual({
      model: CLEF,
      answers: {
        urgent: { type: 'boolean', probability: 0.8998 },
        team: {
          type: 'choice',
          choice: 'technical',
          probabilities: { billing: 0.0605, technical: 0.931, sales: 0.0085 },
          confidence: 0.8058,
        },
        severity: {
          type: 'score',
          score: 2.9603,
          probabilities: { '0': 0.0035, '1': 0.0035, '2': 0.0222, '3': 0.9708 },
          confidence: 0.9239,
        },
      },
      usage: { inputTokens: 381, outputTokens: 0, totalTokens: 381 },
    });
  });

  it('sends images in key order and logs only their format and size', async () => {
    run.mockImplementation(cfOk(CF_RESULT));
    await handleAssessment(
      { ...CF_CTX, logContent: true },
      { ...parsed, assets: { b: img('png', PNG_B64), a: img('webp', WEBP_B64) } },
    );

    const sent = run.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.images).toEqual([
      { content_type: 'image/png', base64: PNG_B64 },
      { content_type: 'image/webp', base64: WEBP_B64 },
    ]);
    expect(sent).not.toHaveProperty('assets');
    const log = mocks.recordAssessmentLog.mock.calls[0][0] as Record<string, unknown>;
    expect(log.assets).toEqual({
      b: { format: 'png', bytes: Buffer.from(PNG_B64, 'base64').length },
      a: { format: 'webp', bytes: 34 },
    });
    const logged = JSON.stringify(log);
    expect(logged).not.toContain(PNG_B64);
    expect(logged).not.toContain(WEBP_B64);
    expect(log.projectId).toBe(cloudflare.projectId);
    expect(log.id).toBe(usageRow().id);
  });

  it('writes the usage row before the request log', async () => {
    run.mockImplementation(cfOk(CF_RESULT, CF_HEADERS));
    const order: string[] = [];
    mocks.recordUsage.mockImplementationOnce(async () => {
      order.push('usage');
    });
    mocks.recordAssessmentLog.mockImplementationOnce(async () => {
      order.push('log');
    });
    await handleAssessment({ ...CF_CTX, logContent: true }, parsed);
    expect(order).toEqual(['usage', 'log']);
  });

  it("turns a 422 into a 400 carrying Cloudflare's cleaned message", async () => {
    run.mockImplementation(
      cfErr(
        422,
        3030,
        'AiError: AiError: Request requires 51796 tokens; the maximum is 24576 (1e50b5c4-37d8-473a-b7a4-8afaf3423bf6)',
      ),
    );
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        message: 'Request requires 51796 tokens; the maximum is 24576',
        type: 'invalid_request_error',
        param: null,
        code: 'upstream_invalid_request',
      },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      status: 'error',
      errorMessage: 'upstream_http_422',
      gatewayRequestId: '1e50b5c4-37d8-473a-b7a4-8afaf3423bf6',
      cloudflareCredentialId: cloudflare.cloudflareCredentialId,
    });
    // Cloudflare rejected the call, so nothing was billed: the cost stays NULL (D6).
    expect(usageRow()).not.toHaveProperty('costUsd');
  });

  it('turns a 413 context pre-check into a 400 and prefers cf-ray as the request id', async () => {
    run.mockImplementation(
      cfErr(
        413,
        5021,
        'AiError: Ai: The estimated number of input and maximum output tokens (58171) exceeded this model context window limit (24576). (4331f49d-c7f7-45a6-b2a7-ebf0660854ef)',
        { 'cf-ray': 'ray-413' },
      ),
    );
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        message:
          'The estimated number of input and maximum output tokens (58171) exceeded this model context window limit (24576).',
        type: 'invalid_request_error',
        param: null,
        code: 'upstream_invalid_request',
      },
    });
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_413', gatewayRequestId: 'ray-413' });
  });

  it('never puts the account id, state or questions in an error response', async () => {
    for (const message of ['AiError: Bad input', `AiError: Bad input for account ${ACCOUNT_ID}`]) {
      run.mockImplementation(cfErr(400, 5006, message));
      const res = await handleAssessment(CF_CTX, parsed);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(ACCOUNT_ID);
      expect(text).not.toContain('charged twice');
      expect(text).not.toContain('Is a refund requested?');
    }
  });

  it('classifies a 401 against the Cloudflare credential only and returns the typed 503', async () => {
    run.mockImplementation(cfErr(401, 10000, 'Authentication error'));
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(NEUTRAL_503);
    expect(mocks.normalizeProjectGatewayError).not.toHaveBeenCalled();
    expect(mocks.normalizeProjectCloudflareError).toHaveBeenCalledOnce();
    const [snapshot, seen] = mocks.normalizeProjectCloudflareError.mock.calls[0];
    expect(snapshot).toBe(cloudflare);
    expect(APICallError.isInstance(seen)).toBe(true);
    expect((seen as APICallError).statusCode).toBe(401);
    expect(RetryError.isInstance(seen)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      errorMessage: 'project_gateway_unavailable',
      cloudflareCredentialId: cloudflare.cloudflareCredentialId,
    });
    expect(usageRow()).not.toHaveProperty('gatewayCredentialId');
  });

  it('treats a 403 with code 10000 as a credential failure', async () => {
    run.mockImplementation(cfErr(403, 10000, 'Authentication error'));
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(NEUTRAL_503);
    expect(mocks.normalizeProjectGatewayError).not.toHaveBeenCalled();
    expect(usageRow()).toMatchObject({ errorMessage: 'project_gateway_unavailable' });
  });

  it('keeps other 403s an opaque upstream error', async () => {
    run.mockImplementation(cfErr(403, 3023, 'Account blocked'));
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual(UPSTREAM_502);
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_403' });
  });

  it('does not retry 429 code 3036 and forwards Retry-After', async () => {
    run.mockImplementation(
      cfErr(
        429,
        3036,
        "AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan",
        { 'retry-after': '3600' },
      ),
    );
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe('rate_limit_exceeded');
    expect(error.message).toBe('The upstream provider rate limit or quota was exceeded. Please retry later.');
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_429' });
  });

  it('retries 429 code 3040 under one deadline and records one ok row', async () => {
    vi.useFakeTimers();
    run
      .mockImplementationOnce(cfErr(429, 3040, 'Capacity temporarily exceeded'))
      .mockImplementationOnce(cfErr(429, 3040, 'Capacity temporarily exceeded'))
      .mockImplementationOnce(cfOk(CF_RESULT, CF_HEADERS));
    const pending = handleAssessment(CF_CTX, parsed);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await pending).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0][2]).toBe(run.mock.calls[2][2]); // one deadline across attempts
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ status: 'ok' });
  });

  it('gives up on 3040 after three attempts with a 429', async () => {
    vi.useFakeTimers();
    run.mockImplementation(cfErr(429, 3040, 'Capacity temporarily exceeded'));
    const pending = handleAssessment(CF_CTX, parsed);
    await vi.advanceTimersByTimeAsync(6_000);
    const res = await pending;

    expect(res.status).toBe(429);
    expect(run).toHaveBeenCalledTimes(3);
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_429' });
  });

  it('retries a dropped connection', async () => {
    vi.useFakeTimers();
    run
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }))
      .mockImplementationOnce(cfOk(CF_RESULT));
    const pending = handleAssessment(CF_CTX, parsed);
    await vi.advanceTimersByTimeAsync(2_000);

    expect((await pending).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('treats a 2xx envelope with success:false as unusable, without retrying', async () => {
    run.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ result: null, success: false, errors: [{ code: 1000, message: 'x' }], messages: [] }),
          { status: 200 },
        ),
    );
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual(UPSTREAM_502);
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_502' });
    // This 2xx carried no cf-ai-neurons header: nothing to meter.
    expect(usageRow()).not.toHaveProperty('costUsd');
  });

  it('treats a result missing an asked answer as unusable and keeps the request id', async () => {
    run.mockImplementation(cfOk({ ...CF_RESULT, answers: {} }, CF_HEADERS));
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual(UPSTREAM_502);
    expect(run).toHaveBeenCalledOnce();
    // Cloudflare billed this 2xx (cf-ai-neurons 10 → $0.00011), so its error row is metered (U1).
    expect(usageRow()).toMatchObject({
      status: 'error',
      errorMessage: 'upstream_http_502',
      gatewayRequestId: REQ_ID,
      costUsd: 0.00011,
      cloudflareCredentialId: cloudflare.cloudflareCredentialId,
    });
  });

  it('records upstream_timeout when the deadline fires', async () => {
    run.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(502);
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_timeout', gatewayRequestId: null });
    expect(usageRow()).not.toHaveProperty('costUsd');
  });

  it('records an error usage row and an error log on failure', async () => {
    run.mockRejectedValue(new Error('socket hang up'));
    await handleAssessment({ ...CF_CTX, logContent: true }, parsed);

    expect(run).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      status: 'error',
      responseKind: 'assessment',
      cloudflareCredentialId: cloudflare.cloudflareCredentialId,
      usage: expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      errorMessage: 'upstream_error',
    });
    expect(mocks.recordAssessmentLog.mock.calls[0][0]).toMatchObject({
      status: 'error',
      answers: null,
      projectId: cloudflare.projectId,
    });
  });

  it('refuses a non-evaluation or unregistered @cf/ model before calling upstream', async () => {
    for (const model of [CLAIRIC, '@cf/cloudflare/unknown']) {
      mocks.recordUsage.mockClear();
      const res = await handleAssessment({ ...CF_CTX, model }, parsed);
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toEqual(UPSTREAM_502);
      expect(usageRow()).toMatchObject({
        status: 'error',
        model,
        errorMessage: 'upstream_cloudflaremodelnotregisterederror',
      });
      expect(usageRow()).not.toHaveProperty('costUsd');
    }
    expect(run).not.toHaveBeenCalled();
    expect(mocks.normalizeProjectGatewayError).not.toHaveBeenCalled();
  });
});

describe('handleAssessment — Cloudflare Clef, billed but unusable 2xx (U1)', () => {
  it.each([
    ['an answer of an unknown type', { refund: { type: 'histogram' } }],
    ['an answer that is not an object', { refund: 5 }],
  ])('meters a billed 2xx with %s, keeping its request id', async (_case, answers) => {
    run.mockImplementation(cfOk({ ...CF_RESULT, answers }, CF_HEADERS));
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual(UPSTREAM_502);
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      status: 'error',
      errorMessage: 'upstream_http_502',
      gatewayRequestId: REQ_ID,
      costUsd: 0.00011,
    });
  });

  it('meters a billed 2xx whose body is malformed JSON', async () => {
    run.mockImplementation(
      async () =>
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json', ...CF_HEADERS },
        }),
    );
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual(UPSTREAM_502);
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      errorMessage: 'upstream_http_502',
      gatewayRequestId: REQ_ID,
      costUsd: 0.00011,
    });
  });

  it('meters a billed 2xx envelope with success:false', async () => {
    run.mockImplementation(
      async () =>
        new Response(JSON.stringify({ result: null, success: false, errors: [], messages: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json', ...CF_HEADERS },
        }),
    );
    const res = await handleAssessment(CF_CTX, parsed);

    expect(res.status).toBe(502);
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_502', costUsd: 0.00011 });
  });

  it('meters a billed 2xx whose body the deadline cut off, as an upstream_timeout', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      run.mockImplementation(async (_model, _body, signal) => stalledSuccess(signal, CF_HEADERS));
      const pending = handleAssessment(CF_CTX, parsed);
      await new Promise((resolve) => setTimeout(resolve, 0)); // the body read is now in flight
      deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      const res = await pending;

      expect(timeout).toHaveBeenCalledWith(120_000);
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toEqual(UPSTREAM_502);
      expect(run).toHaveBeenCalledOnce(); // a timeout is never retried
      expect(usageRow()).toMatchObject({
        status: 'error',
        errorMessage: 'upstream_timeout',
        gatewayRequestId: REQ_ID,
        costUsd: 0.00011,
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it('meters the billed attempt when it follows a retried 5xx', async () => {
    vi.useFakeTimers();
    run
      .mockImplementationOnce(cfErr(503, 0, 'Service unavailable', { 'cf-ai-req-id': 'first-attempt' }))
      .mockImplementationOnce(cfOk({ ...CF_RESULT, answers: {} }, CF_HEADERS));
    const pending = handleAssessment(CF_CTX, parsed);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;

    expect(res.status).toBe(502);
    expect(run).toHaveBeenCalledTimes(2);
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      errorMessage: 'upstream_http_502',
      gatewayRequestId: REQ_ID,
      costUsd: 0.00011,
    });
  });

  it('keeps a NULL cost when Cloudflare rejected every attempt, even with a neurons header', async () => {
    vi.useFakeTimers();
    run.mockImplementation(cfErr(503, 0, 'Service unavailable', CF_HEADERS));
    const pending = handleAssessment(CF_CTX, parsed);
    await vi.advanceTimersByTimeAsync(6_000);
    const res = await pending;

    expect(res.status).toBe(502);
    expect(run).toHaveBeenCalledTimes(3);
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_503', gatewayRequestId: REQ_ID });
    expect(usageRow()).not.toHaveProperty('costUsd');
  });

  it('keeps a NULL cost and no request id when the connection never got a response', async () => {
    vi.useFakeTimers();
    run.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }));
    const pending = handleAssessment(CF_CTX, parsed);
    await vi.advanceTimersByTimeAsync(6_000);
    const res = await pending;

    expect(res.status).toBe(502);
    expect(run).toHaveBeenCalledTimes(3);
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_ai_retryerror', gatewayRequestId: null });
    expect(usageRow()).not.toHaveProperty('costUsd');
  });
});
