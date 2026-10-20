import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recordUsage: vi.fn<(input: unknown) => Promise<void>>(),
  recordExtractionLog: vi.fn<(input: unknown) => Promise<void>>(),
  normalizeProjectCloudflareError: vi.fn(async (_snapshot: unknown, error: unknown) => error),
  normalizeProjectGatewayError: vi.fn(async (_snapshot: unknown, error: unknown) => error),
}));

vi.mock('@/lib/usage/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/usage/record')>()),
  recordUsage: mocks.recordUsage,
  recordExtractionLog: mocks.recordExtractionLog,
}));
vi.mock('@/lib/gateway/cloudflare-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/cloudflare-provider')>()),
  normalizeProjectCloudflareError: mocks.normalizeProjectCloudflareError,
}));
// A spy only: proves a Cloudflare failure never reaches the Vercel normaliser (D3).
vi.mock('@/lib/gateway/project-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/project-provider')>()),
  normalizeProjectGatewayError: mocks.normalizeProjectGatewayError,
}));

import { APICallError, RetryError } from 'ai';
import { handleExtraction } from '@/lib/gateway/extraction';
import type { ParsedExtractionRequest } from '@/lib/gateway/extraction-parse';
import { cloudflareCostUsd } from '@/lib/gateway/cloudflare-call';
import type { ProjectCloudflareSnapshot } from '@/lib/gateway/cloudflare-provider';
import { ProjectCloudflareUnavailableError } from '@/lib/gateway/project-provider';
import { NATIVE_UPSTREAM_TIMEOUT_MS } from '@/lib/gateway/retries';
import type { ExtractionFieldSpec } from '@/lib/http/openai';

/**
 * handleExtraction (POST /v1/extract) against an injected Cloudflare runner: the
 * upstream body, usage attribution and cost (D6, D7, U1), content logging, and the
 * contract §4.2 error mapping. No network and no database.
 */

// ---- Live fixtures (Clairic, 2026-10-20) --------------------------------------

const CLAIRIC = '@cf/cloudflare/clairic';

const INVOICE_STATE =
  'Invoice INV-7731 from Blue Harbor Logistics. Issued 14 Oct. Net 15. Freight: 3 pallets at $410.00 each; fuel surcharge $57.50. Contacts: Meera Iyer, Tom Okafor.';
const INVOICE_FIELDS: Record<string, ExtractionFieldSpec> = {
  invoice_number: { type: 'text', instructions: 'Invoice number' },
  total: { type: 'number', unit: 'USD', decimals: 2, instructions: 'Amount due including the surcharge' },
  due_date: { type: 'date', instructions: 'Issue date plus the net payment days' },
  contacts: { type: 'list', items: 'text', instructions: 'Contact person names' },
  po_number: { type: 'text', instructions: 'Purchase order number' },
  days_to_pay: { type: 'estimate', min: 0, max: 90, step: 1, instructions: 'Days after issue until this invoice is paid' },
};
const INVOICE_RESULT = {
  model: 'clairic',
  answers: {
    invoice_number: { type: 'text', p_null: 0.00009758886153576896, span: [8, 16], guess: 'INV-7731', confidence: 1, value: 'INV-7731' },
    total: { type: 'number', p_null: 0.0002998378186021, guess: 1287.5, confidence: 0.8682515184261609, value: 1287.5 },
    due_date: { type: 'date', p_null: 0.000010327539712307043, guess: '2026-10-29', confidence: 0.9999454048181, value: '2026-10-29' },
    contacts: { type: 'list', value: ['Meera Iyer', 'Tom Okafor'], spans: [[137, 147], [149, 159]], confidence: 0.9707825068312013 },
    po_number: { type: 'text', p_null: 0.9999994039535522, span: [8, 16], guess: 'INV-7731', confidence: 0.999321699142456, value: null },
    days_to_pay: { type: 'estimate', value: 18, mean: 17.58255853506008, median: 16, p10: 13, p90: 25, p_below: 0.000008598190106567927, p_above: 0.00000881781852513086 },
  },
  truncated: false,
  usage: { state_tokens: 62, image_tokens: 0, schema_tokens: 529, input_tokens: 715, output_tokens: 0, passes: 3 },
};

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'; // 1x1 PNG
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQ=='; // FF D8 FF E0 … JFIF header bytes
const png = (data = PNG_B64) => ({ type: 'image' as const, format: 'png' as const, data_base64: data });

// ---- Setup ------------------------------------------------------------------------

const REQ_ID = 'ce8c7745-ca64-4a50-98f2-6b2189c48a3f'; // cf-ai-req-id from the raw probe
const RAY = 'a4d766322e1ba01b-FRA';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const SENTINEL = 'STATE-TEXT-SENTINEL-6f1c'; // a state_text distinct from the state
/** cf-ai-neurons on a billed 2xx Sophy could not use: 40 × $0.011/1k = $0.00044 (U1). */
const NEURONS = '40';
const BILLED_COST = 0.00044;
const FALLBACK = 'The extraction request failed.';

const run = vi.fn<(model: string, body: unknown, signal: AbortSignal) => Promise<Response>>();
const cloudflare: ProjectCloudflareSnapshot = {
  projectId: '00000000-0000-4000-8000-000000000001',
  cloudflareCredentialId: '00000000-0000-4000-8000-000000000004',
  credentialRevision: 1,
  accountId: ACCOUNT,
  runner: { run },
};
const CTX = { keyId: 'key-1', model: CLAIRIC, logContent: false, cloudflare };
const LOG_CTX = { ...CTX, logContent: true };
const PARSED: ParsedExtractionRequest = {
  state: INVOICE_STATE,
  fields: INVOICE_FIELDS,
  referenceDate: '2026-10-20',
  options: {},
};

/** A fresh Response per call: a body can only be read once, and retries re-read. */
function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}
const envelope = (result: unknown) => ({ result, success: true, errors: [], messages: [] });
const cfFailure = (code: number, message: string) => ({
  result: null,
  success: false,
  errors: [{ code, message }],
  messages: [],
});
const usageRow = (i = 0) => mocks.recordUsage.mock.calls[i][0] as Record<string, unknown>;
const logRow = () => mocks.recordExtractionLog.mock.calls[0][0] as Record<string, unknown>;
async function errorOf(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { error: Record<string, unknown> }).error;
}
/** A billed 200 whose body is still streaming when `signal` aborts; the read then fails with the abort reason. */
function stalledSuccess(signal: AbortSignal, headers: Record<string, string>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"result":{"model":"clairic"'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json', ...headers } },
  );
}

beforeEach(() => {
  run.mockReset();
  mocks.recordUsage.mockClear();
  mocks.recordExtractionLog.mockClear();
  mocks.normalizeProjectCloudflareError.mockClear();
  mocks.normalizeProjectGatewayError.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('handleExtraction — happy path', () => {
  it('posts the Clairic body through the project runner and returns the passthrough payload', async () => {
    run.mockImplementation(
      respond(200, envelope(INVOICE_RESULT), { 'cf-ai-neurons': '100', 'cf-ai-req-id': REQ_ID, 'cf-ray': RAY }),
    );
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toStrictEqual({
      model: CLAIRIC,
      answers: INVOICE_RESULT.answers,
      truncated: false,
      usage: { inputTokens: 715, outputTokens: 0, totalTokens: 715 },
    });
    expect(run).toHaveBeenCalledOnce();
    const [model, body, signal] = run.mock.calls[0];
    expect(model).toBe(CLAIRIC);
    expect(body).toStrictEqual({
      model: 'clairic',
      state: INVOICE_STATE,
      fields: INVOICE_FIELDS,
      reference_date: '2026-10-20',
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts a bare Clairic body as well as the v4 envelope', async () => {
    run.mockImplementation(respond(200, INVOICE_RESULT, { 'cf-ai-req-id': REQ_ID }));
    const res = await handleExtraction(CTX, PARSED);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).answers).toStrictEqual(INVOICE_RESULT.answers);
    expect(usageRow()).toMatchObject({ status: 'ok', gatewayRequestId: REQ_ID });
  });

  it('sends images in key order, an empty state, and never assets, providerOptions or the full model id', async () => {
    run.mockImplementation(respond(200, envelope(INVOICE_RESULT)));
    await handleExtraction(CTX, {
      ...PARSED,
      state: '',
      assets: { b: png(), a: { type: 'image', format: 'jpg', data_base64: JPEG_B64 } },
    });
    const body = run.mock.calls[0][1] as Record<string, unknown>;
    expect(body.images).toEqual([
      { content_type: 'image/png', base64: PNG_B64 },
      { content_type: 'image/jpeg', base64: JPEG_B64 },
    ]);
    expect(body.state).toBe('');
    expect(body.model).toBe('clairic');
    expect(body).not.toHaveProperty('assets');
    expect(body).not.toHaveProperty('providerOptions');
  });

  it('records one ok usage row against the Cloudflare credential, with the neurons cost and cf-ai-req-id', async () => {
    run.mockImplementation(
      respond(200, envelope(INVOICE_RESULT), { 'cf-ai-neurons': '100', 'cf-ai-req-id': REQ_ID, 'cf-ray': RAY }),
    );
    await handleExtraction(CTX, PARSED);

    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      projectId: cloudflare.projectId,
      cloudflareCredentialId: cloudflare.cloudflareCredentialId,
      keyId: 'key-1',
      provider: 'cloudflare',
      model: CLAIRIC,
      status: 'ok',
      responseKind: 'extraction',
      costUsd: 0.0011, // 100 neurons × $0.011/1k
      gatewayRequestId: REQ_ID,
      usage: expect.objectContaining({ inputTokens: 715, outputTokens: 0, totalTokens: 715 }),
    });
    expect(usageRow()).not.toHaveProperty('gatewayCredentialId');
    expect(typeof usageRow().id).toBe('string');
  });

  it('prices by input tokens at the registry rate when cf-ai-neurons is absent, and falls back to cf-ray', async () => {
    run.mockImplementation(respond(200, envelope(INVOICE_RESULT), { 'cf-ray': RAY }));
    await handleExtraction(CTX, PARSED);

    // 715 tokens × $0.10/M, rounded to 6 decimals (D6).
    expect(usageRow().costUsd).toBe(cloudflareCostUsd({ model: CLAIRIC, neurons: null, inputTokens: 715, outputTokens: 0 }));
    expect(usageRow().costUsd).toBeCloseTo(0.0000715, 5);
    expect(usageRow().gatewayRequestId).toBe(RAY);
  });

  it('returns state_text only when the client asked for it', async () => {
    run.mockImplementation(respond(200, envelope({ ...INVOICE_RESULT, state_text: SENTINEL })));
    const asked = await handleExtraction(CTX, { ...PARSED, options: { return_state_text: true } });
    expect(((await asked.json()) as Record<string, unknown>).state_text).toBe(SENTINEL);
    expect((run.mock.calls[0][1] as Record<string, unknown>).options).toEqual({ return_state_text: true });

    const notAsked = await handleExtraction(CTX, { ...PARSED, options: {} });
    expect(await notAsked.json()).not.toHaveProperty('state_text');
    expect(run.mock.calls[1][1]).not.toHaveProperty('options');
  });

  it('gives every attempt the one 120 s deadline', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      run
        .mockImplementationOnce(respond(503, cfFailure(3043, 'AiError: Internal server error')))
        .mockImplementationOnce(respond(200, envelope(INVOICE_RESULT)));
      const pending = handleExtraction(CTX, PARSED);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).status).toBe(200);
      expect(timeout).toHaveBeenCalledOnce();
      expect(timeout).toHaveBeenCalledWith(NATIVE_UPSTREAM_TIMEOUT_MS);
      expect(run.mock.calls[1][2]).toBe(run.mock.calls[0][2]);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('handleExtraction — content logging', () => {
  it('does not log content when the key opted out', async () => {
    run.mockImplementation(respond(200, envelope(INVOICE_RESULT)));
    await handleExtraction(CTX, PARSED);
    expect(mocks.recordExtractionLog).not.toHaveBeenCalled();
  });

  it('logs state, fields, reference date and answers under the usage event id', async () => {
    run.mockImplementation(respond(200, envelope(INVOICE_RESULT)));
    await handleExtraction(LOG_CTX, PARSED);

    expect(mocks.recordExtractionLog).toHaveBeenCalledOnce();
    expect(logRow()).toMatchObject({
      projectId: cloudflare.projectId,
      keyId: 'key-1',
      state: INVOICE_STATE,
      fields: INVOICE_FIELDS,
      referenceDate: '2026-10-20',
      answers: INVOICE_RESULT.answers,
      truncated: false,
      status: 'ok',
    });
    expect(logRow().id).toBe(usageRow().id);
    expect(logRow()).not.toHaveProperty('options');
  });

  it('writes the usage row before the request log (request_logs has the FK)', async () => {
    const order: string[] = [];
    mocks.recordUsage.mockImplementationOnce(async () => {
      order.push('usage');
    });
    mocks.recordExtractionLog.mockImplementationOnce(async () => {
      order.push('log');
    });
    run.mockImplementation(respond(200, envelope(INVOICE_RESULT)));
    await handleExtraction(LOG_CTX, PARSED);
    expect(order).toEqual(['usage', 'log']);
  });

  it('logs image format and size and the requested options, never image bytes or state_text', async () => {
    run.mockImplementation(respond(200, envelope({ ...INVOICE_RESULT, state_text: SENTINEL })));
    const res = await handleExtraction(LOG_CTX, {
      ...PARSED,
      assets: { receipt: png() },
      options: { return_state_text: true },
    });
    expect(res.status).toBe(200);

    expect(logRow().assets).toEqual({ receipt: { format: 'png', bytes: Buffer.from(PNG_B64, 'base64').length } });
    expect(logRow().options).toEqual({ return_state_text: true });
    const text = JSON.stringify(logRow());
    expect(text).not.toContain(PNG_B64);
    expect(text).not.toContain(SENTINEL);
    expect(logRow()).not.toHaveProperty('state_text');
    expect(logRow()).not.toHaveProperty('stateText');
  });

  it('records an error usage row and an error log on failure', async () => {
    run.mockRejectedValue(new Error('socket hang up'));
    await handleExtraction(LOG_CTX, PARSED);

    expect(usageRow()).toMatchObject({
      status: 'error',
      responseKind: 'extraction',
      cloudflareCredentialId: cloudflare.cloudflareCredentialId,
      usage: expect.objectContaining({ inputTokens: 0, outputTokens: 0 }),
    });
    expect(usageRow().costUsd ?? null).toBeNull();
    expect(logRow()).toMatchObject({ status: 'error', answers: null });
    expect(logRow().id).toBe(usageRow().id);
  });
});

describe('handleExtraction — upstream failures (contract §4.2)', () => {
  it('echoes the cleaned 400/5006 message as upstream_invalid_request and records its request id', async () => {
    run.mockImplementation(
      respond(
        400,
        cfFailure(
          5006,
          "AiError: Bad input: Error: enum currency not in text,number,date,time,datetime,duration,list,estimate,forecast at '/total/type' (94720971-4386-46ff-93ad-9b96b1602365)",
        ),
      ),
    );
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      type: 'invalid_request_error',
      code: 'upstream_invalid_request',
      message:
        "Bad input: Error: enum currency not in text,number,date,time,datetime,duration,list,estimate,forecast at '/total/type'",
    });
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      status: 'error',
      errorMessage: 'upstream_http_400',
      gatewayRequestId: '94720971-4386-46ff-93ad-9b96b1602365',
    });
    expect(usageRow()).not.toHaveProperty('costUsd');
  });

  it.each([
    [413, 5021],
    [422, 3030],
  ])('maps a %i (code %i) to a client 400 without retrying', async (status, code) => {
    run.mockImplementation(
      respond(
        status,
        cfFailure(code, 'AiError: Request requires 70000 tokens; the maximum is 65536 (1e50b5c4-0000-4000-8000-000000000000)'),
      ),
    );
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      code: 'upstream_invalid_request',
      message: 'Request requires 70000 tokens; the maximum is 65536',
    });
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: `upstream_http_${status}` });
  });

  it('turns a 401 into the typed 503 through the Cloudflare normaliser only', async () => {
    run.mockImplementation(respond(401, cfFailure(10000, 'Authentication error')));
    mocks.normalizeProjectCloudflareError.mockImplementationOnce(
      async (_s: unknown, error: unknown) =>
        new ProjectCloudflareUnavailableError(
          cloudflare.projectId,
          'credential_invalid',
          cloudflare.cloudflareCredentialId,
          error,
        ),
    );
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({ type: 'api_error', code: 'project_gateway_unavailable' });
    expect(mocks.normalizeProjectCloudflareError).toHaveBeenCalledOnce();
    const [snapshot, error] = mocks.normalizeProjectCloudflareError.mock.calls[0];
    expect(snapshot).toBe(cloudflare);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).statusCode).toBe(401);
    expect(RetryError.isInstance(error)).toBe(false);
    expect(mocks.normalizeProjectGatewayError).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      errorMessage: 'project_gateway_unavailable',
      cloudflareCredentialId: cloudflare.cloudflareCredentialId,
    });
    expect(usageRow()).not.toHaveProperty('gatewayCredentialId');
    expect(usageRow()).not.toHaveProperty('costUsd');
  });

  it('keeps any other 403 an opaque 502', async () => {
    run.mockImplementation(respond(403, cfFailure(3023, 'Account blocked')));
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: 'upstream_error', message: FALLBACK });
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_403' });
  });

  it('maps a 402 to insufficient_quota', async () => {
    run.mockImplementation(respond(402, cfFailure(1000, 'Payment required')));
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(402);
    expect(await errorOf(res)).toMatchObject({ type: 'insufficient_quota', code: 'insufficient_quota' });
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_402' });
  });

  it('does not retry the daily free allocation (429/3036) and forwards Retry-After', async () => {
    run.mockImplementation(
      respond(429, cfFailure(3036, 'You have used up your daily free allocation of 10,000 neurons.'), {
        'retry-after': '3600',
      }),
    );
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(await errorOf(res)).toMatchObject({ code: 'rate_limit_exceeded' });
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_429' });
  });

  it('retries a capacity 429 (3040) twice, then answers 429', async () => {
    vi.useFakeTimers();
    run.mockImplementation(respond(429, cfFailure(3040, 'Capacity temporarily exceeded, please try again.')));
    const pending = handleExtraction(CTX, PARSED);
    await vi.advanceTimersByTimeAsync(6_000);
    const res = await pending;

    expect(run).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(429);
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_429' });
    expect(usageRow()).not.toHaveProperty('costUsd');
  });

  it('turns a 200 with success:false into a 502 without retrying', async () => {
    run.mockImplementation(
      respond(200, { result: null, success: false, errors: [], messages: [] }, {
        'cf-ai-neurons': NEURONS,
        'cf-ai-req-id': REQ_ID,
      }),
    );
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: 'upstream_error', message: FALLBACK });
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      status: 'error',
      errorMessage: 'upstream_http_502',
      gatewayRequestId: REQ_ID,
      costUsd: BILLED_COST, // U1: billed but unusable is still metered
    });
  });

  it('turns a missing asked answer into a 502 and keeps the request id', async () => {
    run.mockImplementation(
      respond(200, envelope({ ...INVOICE_RESULT, answers: { total: INVOICE_RESULT.answers.total } }), {
        'cf-ai-req-id': REQ_ID,
        'cf-ai-neurons': NEURONS,
      }),
    );
    const res = await handleExtraction(LOG_CTX, PARSED);

    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: 'upstream_error', message: FALLBACK });
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({
      status: 'error',
      errorMessage: 'upstream_http_502',
      gatewayRequestId: REQ_ID,
      // U1: neurons only, priced like a neurons-only call; the row keeps zero tokens.
      costUsd: cloudflareCostUsd({ model: CLAIRIC, neurons: 40, inputTokens: 0, outputTokens: 0 }),
      usage: expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    });
    expect(usageRow().costUsd).toBe(BILLED_COST);
    expect(logRow()).toMatchObject({ status: 'error', answers: null });
  });

  it('turns a non-object answer into a 502', async () => {
    run.mockImplementation(
      respond(200, envelope({ ...INVOICE_RESULT, answers: { ...INVOICE_RESULT.answers, total: 5 } }), {
        'cf-ai-req-id': REQ_ID,
        'cf-ai-neurons': NEURONS,
      }),
    );
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(502);
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_502', gatewayRequestId: REQ_ID, costUsd: BILLED_COST });
  });

  it('turns malformed JSON on a 200 into a 502', async () => {
    run.mockImplementation(
      async () =>
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json', 'cf-ai-neurons': NEURONS, 'cf-ray': RAY },
        }),
    );
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: 'upstream_error' });
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_502', gatewayRequestId: RAY, costUsd: BILLED_COST });
  });

  it('does not retry the deadline and records upstream_timeout', async () => {
    run.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const res = await handleExtraction(CTX, PARSED);

    expect(run).toHaveBeenCalledOnce();
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: 'upstream_error', message: FALLBACK });
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_timeout', gatewayRequestId: null });
    expect(usageRow()).not.toHaveProperty('costUsd');
  });

  it('never leaks the state, field instructions or the account id to the client', async () => {
    for (const response of [
      respond(400, cfFailure(5006, 'AiError: Bad input (94720971-4386-46ff-93ad-9b96b1602365)')),
      respond(404, cfFailure(7003, 'No route for that URI')),
      respond(
        400,
        cfFailure(7003, `Could not route to /client/v4/accounts/${ACCOUNT}/ai/run, perhaps your object identifier is invalid?`),
      ),
    ]) {
      run.mockImplementationOnce(response);
      const res = await handleExtraction(LOG_CTX, PARSED);
      const text = await res.text();
      expect(text).not.toContain('Blue Harbor');
      expect(text).not.toContain('Amount due including the surcharge');
      expect(text).not.toContain(ACCOUNT);
    }
    for (const call of mocks.recordUsage.mock.calls) expect(JSON.stringify(call[0])).not.toContain(ACCOUNT);
  });
});

describe('handleExtraction — billed but unusable responses (U1)', () => {
  it('meters a deadline that fires while the billed body is being read, and records upstream_timeout', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      run.mockImplementation(async (_model, _body, signal) =>
        stalledSuccess(signal, { 'cf-ai-neurons': NEURONS, 'cf-ai-req-id': REQ_ID }),
      );
      const pending = handleExtraction(LOG_CTX, PARSED);
      await new Promise((resolve) => setTimeout(resolve, 0)); // the body read is now in flight
      deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      const res = await pending;

      expect(timeout).toHaveBeenCalledWith(NATIVE_UPSTREAM_TIMEOUT_MS);
      expect(run).toHaveBeenCalledOnce(); // an abort is never retried
      expect(res.status).toBe(502);
      expect(await errorOf(res)).toMatchObject({ code: 'upstream_error', message: FALLBACK });
      expect(mocks.recordUsage).toHaveBeenCalledOnce();
      expect(usageRow()).toMatchObject({
        status: 'error',
        errorMessage: 'upstream_timeout',
        gatewayRequestId: REQ_ID,
        costUsd: BILLED_COST,
      });
      expect(logRow()).toMatchObject({ status: 'error', answers: null });
    } finally {
      timeout.mockRestore();
    }
  });

  it('meters the billed 2xx that ends a retried call', async () => {
    vi.useFakeTimers();
    run
      .mockImplementationOnce(respond(503, cfFailure(3043, 'AiError: Internal server error')))
      .mockImplementationOnce(
        respond(200, { result: null, success: false, errors: [], messages: [] }, {
          'cf-ai-neurons': NEURONS,
          'cf-ai-req-id': REQ_ID,
        }),
      );
    const pending = handleExtraction(CTX, PARSED);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;

    expect(run).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(502);
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_502', gatewayRequestId: REQ_ID, costUsd: BILLED_COST });
  });

  it('keeps a NULL cost for an unusable 2xx that carries no neurons header', async () => {
    run.mockImplementation(respond(200, envelope({ ...INVOICE_RESULT, answers: {} }), { 'cf-ai-req-id': REQ_ID }));
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).toBe(502);
    expect(usageRow()).toMatchObject({ errorMessage: 'upstream_http_502', gatewayRequestId: REQ_ID });
    expect(usageRow()).not.toHaveProperty('costUsd');
  });

  it.each([
    [400, 5006],
    [401, 10000],
    [403, 3023],
    [404, 7003],
    [413, 5021],
    [422, 3030],
    [429, 3036],
  ])('keeps a NULL cost when Cloudflare rejected the call (%i, code %i), even with a neurons header', async (status, code) => {
    run.mockImplementation(
      respond(status, cfFailure(code, 'AiError: rejected'), { 'cf-ai-neurons': NEURONS, 'cf-ai-req-id': REQ_ID }),
    );
    const res = await handleExtraction(CTX, PARSED);

    expect(res.status).not.toBe(200);
    expect(run).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ status: 'error', gatewayRequestId: REQ_ID });
    expect(usageRow()).not.toHaveProperty('costUsd');
  });

  it('keeps a NULL cost after 5xx and network failures exhaust their retries', async () => {
    vi.useFakeTimers();
    run.mockImplementation(respond(503, cfFailure(3043, 'AiError: Internal server error'), { 'cf-ai-neurons': NEURONS }));
    const failing = handleExtraction(CTX, PARSED);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await failing).status).toBe(502);
    expect(usageRow(0)).toMatchObject({ errorMessage: 'upstream_http_503' });
    expect(usageRow(0)).not.toHaveProperty('costUsd');

    run.mockReset();
    run.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }));
    const dropped = handleExtraction(CTX, PARSED);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await dropped).status).toBe(502);
    expect(run).toHaveBeenCalledTimes(3);
    expect(usageRow(1)).toMatchObject({ status: 'error', gatewayRequestId: null });
    expect(usageRow(1)).not.toHaveProperty('costUsd');
  });
});

describe('handleExtraction — retries', () => {
  it('absorbs a capacity blip: one 200 and one ok usage row', async () => {
    vi.useFakeTimers();
    run
      .mockImplementationOnce(respond(429, cfFailure(3040, 'Capacity temporarily exceeded, please try again.')))
      .mockImplementationOnce(respond(200, envelope(INVOICE_RESULT)));
    const pending = handleExtraction(CTX, PARSED);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(usageRow()).toMatchObject({ status: 'ok' });
  });

  it('retries a dropped connection (fetch failed with a cause)', async () => {
    vi.useFakeTimers();
    run
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }))
      .mockImplementationOnce(respond(200, envelope(INVOICE_RESULT)));
    const pending = handleExtraction(CTX, PARSED);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('leaves no timer behind after a retried success', async () => {
    vi.useFakeTimers();
    run
      .mockImplementationOnce(respond(429, cfFailure(3040, 'Capacity temporarily exceeded, please try again.')))
      .mockImplementationOnce(respond(200, envelope(INVOICE_RESULT)));
    const pending = handleExtraction(CTX, PARSED);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('handleExtraction — fail closed', () => {
  it('never calls upstream when the context model is not a registered extraction model', async () => {
    for (const model of ['@cf/cloudflare/clef', '@cf/cloudflare/clairic-2']) {
      mocks.recordUsage.mockClear();
      const res = await handleExtraction({ ...CTX, model }, PARSED);

      expect(res.status, model).toBe(502);
      expect(await errorOf(res)).toMatchObject({ code: 'upstream_error', message: FALLBACK });
      expect(run).not.toHaveBeenCalled();
      expect(mocks.recordUsage).toHaveBeenCalledOnce();
      expect(usageRow()).toMatchObject({ status: 'error', model });
      expect(usageRow().costUsd ?? null).toBeNull();
      expect(usageRow().errorMessage).toMatch(/^upstream_/);
    }
  });
});
