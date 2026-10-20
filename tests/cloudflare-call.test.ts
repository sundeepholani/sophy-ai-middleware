import { afterEach, describe, expect, it, vi } from 'vitest';

// cloudflare-provider.ts (for CLOUDFLARE_API_BASE) imports the DB client.
vi.mock('@/db/client', () => ({ getDb: vi.fn() }));

import { APICallError, RetryError } from 'ai';
import {
  callCloudflareModel,
  cleanCloudflareMessage,
  cloudflareCostUsd,
  cloudflareCredentialFailure,
  cloudflareErrorInfo,
  cloudflareErrorRequestId,
  cloudflareResponseRequestId,
  cloudflareRetryable,
  cloudflareRunUrlForLogs,
  parseCloudflareErrorBody,
  parseNeuronsHeader,
  postCloudflareOnce,
  roundUsd6,
  unwrapCloudflareEnvelope,
  WORKERS_AI_USD_PER_1K_NEURONS,
} from '@/lib/gateway/cloudflare-call';
import { CloudflareModelNotRegisteredError } from '@/lib/gateway/cloudflare-models';
import {
  CLOUDFLARE_API_BASE,
  type CloudflareRunner,
  type ProjectCloudflareSnapshot,
} from '@/lib/gateway/cloudflare-provider';
import { ProjectCloudflareUnavailableError } from '@/lib/gateway/project-provider';
import { safeGatewayErrorMessage, upstreamErrorResponse } from '@/lib/gateway/upstream-error';

/**
 * Cloudflare Workers AI error lifting, retryability, request ids and cost (D6, D8).
 * The message and header samples are the live ones recorded on 2026-10-20.
 */

const PROJECT = '00000000-0000-4000-8000-000000000001';
const ROW_A = '00000000-0000-4000-8000-000000000002';
const ACCT = '0123456789abcdef0123456789abcdef';
const MODEL = '@cf/cloudflare/clef-flash';
const REQ_ID = 'ce8c7745-ca64-4a50-98f2-6b2189c48a3f';
const RAY = 'a4d766322e1ba01b-FRA';
const FALLBACK = 'The evaluation request failed.';
const OVER_CONTEXT =
  'AiError: AiError: Request requires 51796 tokens; the maximum is 24576 (1e50b5c4-37d8-473a-b7a4-8afaf3423bf6)';

/** The live probe's success body (clef-flash, 222 input tokens). */
const PROBE_RESULT = {
  model: 'clef-flash',
  answers: {
    refund: { type: 'noul', noul: 0.9584 },
    team: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9518, tech: 0.0482 },
      confidence: 0.8164,
    },
  },
  usage: { input_tokens: 222, output_tokens: 0 },
};
const PROBE_HEADERS = {
  'content-type': 'application/json',
  'cf-ai-neurons': '0.77',
  'cf-ai-req-id': REQ_ID,
  'cf-ray': RAY,
};

const run = vi.fn<CloudflareRunner['run']>();
const snapshot: ProjectCloudflareSnapshot = {
  projectId: PROJECT,
  cloudflareCredentialId: ROW_A,
  credentialRevision: 1,
  accountId: ACCT,
  runner: { run },
};

function cfSuccess(): Response {
  return new Response(JSON.stringify({ result: PROBE_RESULT, success: true, errors: [], messages: [] }), {
    status: 200,
    headers: PROBE_HEADERS,
  });
}

/** A v4 error envelope, as Cloudflare sends it. */
function cfFailure(
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ result: null, success: false, errors: [{ code, message }], messages: [] }),
    { status, headers },
  );
}

/** Settle a promise that must reject, returning what it threw. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

/** One attempt against `response`. */
function attemptWith(response: Response): Promise<unknown> {
  run.mockResolvedValueOnce(response);
  return rejection(postCloudflareOnce(snapshot, MODEL, {}, new AbortController().signal));
}

/** A 200 whose body is still streaming when `signal` aborts; the read then fails with the abort reason. */
function stalledSuccess(signal: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"result":{"model":"clef-flash"'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }),
    { status: 200, headers: PROBE_HEADERS },
  );
}

afterEach(() => {
  run.mockReset();
  vi.useRealTimers();
});

describe('Cloudflare error parsing (pure)', () => {
  it.each<[string, string, string, string | null]>([
    [
      '3030 over context',
      OVER_CONTEXT,
      'Request requires 51796 tokens; the maximum is 24576',
      '1e50b5c4-37d8-473a-b7a4-8afaf3423bf6',
    ],
    [
      '5021 context pre-check',
      'AiError: Ai: The estimated number of input and maximum output tokens (58171) exceeded this model context window limit (24576). (4331f49d-c7f7-45a6-b2a7-ebf0660854ef)',
      'The estimated number of input and maximum output tokens (58171) exceeded this model context window limit (24576).',
      '4331f49d-c7f7-45a6-b2a7-ebf0660854ef',
    ],
    [
      '5006 bad input',
      "AiError: Bad input: Error: enum currency not in text,number,date,time,datetime,duration,list,estimate,forecast at '/total/type' (94720971-4386-46ff-93ad-9b96b1602365)",
      "Bad input: Error: enum currency not in text,number,date,time,datetime,duration,list,estimate,forecast at '/total/type'",
      '94720971-4386-46ff-93ad-9b96b1602365',
    ],
    [
      '3030 selector mismatch',
      "AiError: AiError: Unsupported model 'clef-flash'. Use 'clef'. (21cf7238-f55f-48d7-b802-43ca3ca5db95)",
      "Unsupported model 'clef-flash'. Use 'clef'.",
      '21cf7238-f55f-48d7-b802-43ca3ca5db95',
    ],
    ['10000 auth', 'Authentication error', 'Authentication error', null],
  ])('cleans Cloudflare messages and captures the request id: %s', (_label, raw, message, requestId) => {
    expect(cleanCloudflareMessage(raw)).toEqual({ message, requestId });
  });

  it('cleans a message with a long whitespace run in linear time', () => {
    // Messages echo client text (here a field path). A leading \s* in the suffix pattern
    // backtracked quadratically over the run: about 4 s at this size.
    const run = ' '.repeat(60_000);
    const started = performance.now();
    const cleaned = cleanCloudflareMessage(
      `AiError: Bad input at '/a${run}b' (94720971-4386-46ff-93ad-9b96b1602365)`,
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(cleaned).toEqual({
      message: `Bad input at '/a${run}b'`,
      requestId: '94720971-4386-46ff-93ad-9b96b1602365',
    });
  });

  it('parses the v4 error body defensively', () => {
    expect(
      parseCloudflareErrorBody(
        '{"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[]}',
      ),
    ).toEqual({ code: 10000, message: 'Authentication error', requestId: null });
    for (const body of ['<html>', '{}', '{"errors":[]}', '']) {
      expect(parseCloudflareErrorBody(body), body).toEqual({ code: null, message: null, requestId: null });
    }
    expect(parseCloudflareErrorBody('{"errors":[{"code":"3036"}]}')).toEqual({
      code: 3036,
      message: null,
      requestId: null,
    });
    expect(parseCloudflareErrorBody(JSON.stringify({ errors: [{ code: 3030, message: OVER_CONTEXT }] }))).toEqual({
      code: 3030,
      message: 'Request requires 51796 tokens; the maximum is 24576',
      requestId: '1e50b5c4-37d8-473a-b7a4-8afaf3423bf6',
    });
    expect(parseCloudflareErrorBody('{"errors":[{"code":1.5,"message":"x"}]}')).toMatchObject({ code: null });
  });

  it('retries 3040 and other 429s, never 3036', () => {
    const table: [number, number | null, boolean][] = [
      [429, 3036, false],
      [429, 3040, true],
      [429, null, true],
      [408, null, true],
      [409, null, true],
      [500, null, true],
      [503, null, true],
      [401, 10000, false],
      [403, 10000, false],
      [400, 5006, false],
      [413, 5021, false],
      [422, 3030, false],
      [404, null, false],
    ];
    for (const [status, code, retryable] of table) {
      expect(cloudflareRetryable(status, code), `${status}/${code}`).toBe(retryable);
    }
  });

  it('unwraps the v4 envelope', () => {
    const result = { model: 'clef', answers: {} };
    expect(unwrapCloudflareEnvelope({ success: true, result })).toBe(result);
    expect(unwrapCloudflareEnvelope({ result })).toBe(result);
    const bare = { model: 'clef', answers: {} };
    expect(unwrapCloudflareEnvelope(bare)).toBe(bare);
    for (const json of [
      { success: false, result },
      { success: true, result: null },
      { success: true, result: [] },
      null,
      'x',
      [],
    ]) {
      expect(unwrapCloudflareEnvelope(json), JSON.stringify(json)).toBeNull();
    }
  });

  it('parses cf-ai-neurons strictly', () => {
    expect(parseNeuronsHeader('0.77')).toBe(0.77);
    expect(parseNeuronsHeader(' 12 ')).toBe(12);
    expect(parseNeuronsHeader('1e3')).toBe(1000);
    for (const value of [null, '', 'abc', '-1', 'Infinity', '0x10', '1,5', '1e999']) {
      expect(parseNeuronsHeader(value), String(value)).toBeNull();
    }
  });

  it('prefers cf-ai-req-id, then cf-ray', () => {
    expect(cloudflareResponseRequestId(new Headers({ 'cf-ai-req-id': REQ_ID, 'cf-ray': RAY }))).toBe(REQ_ID);
    expect(cloudflareResponseRequestId(new Headers({ 'cf-ray': RAY }))).toBe(RAY);
    expect(cloudflareResponseRequestId(new Headers({ 'cf-ai-req-id': '  ', 'cf-ray': RAY }))).toBe(RAY);
    expect(cloudflareResponseRequestId(new Headers())).toBeNull();
    expect(cloudflareResponseRequestId(new Headers({ 'cf-ai-req-id': 'r'.repeat(300) }))).toBe('r'.repeat(128));
  });

  it('log URLs never carry the account id', () => {
    expect(cloudflareRunUrlForLogs('@cf/cloudflare/clef')).toBe(
      `${CLOUDFLARE_API_BASE}/accounts/{account_id}/ai/run/@cf/cloudflare/clef`,
    );
  });
});

describe('postCloudflareOnce', () => {
  it('returns result, neurons and request id on success', async () => {
    run.mockResolvedValueOnce(cfSuccess());
    const signal = new AbortController().signal;
    await expect(postCloudflareOnce(snapshot, MODEL, { state: 's' }, signal)).resolves.toEqual({
      result: PROBE_RESULT,
      neurons: 0.77,
      upstreamRequestId: REQ_ID,
    });
    expect(run).toHaveBeenCalledWith(MODEL, { state: 's' }, signal);
  });

  it('lifts a 422 into a readable, non-retryable APICallError', async () => {
    // A rejected call carries no billed neurons, even if the header were present (U1).
    const withRay = await attemptWith(cfFailure(422, 3030, OVER_CONTEXT, { 'cf-ray': RAY, 'cf-ai-neurons': '0.5' }));
    expect(APICallError.isInstance(withRay)).toBe(true);
    const error = withRay as APICallError;
    expect(error).toMatchObject({
      statusCode: 422,
      message: 'Request requires 51796 tokens; the maximum is 24576',
      isRetryable: false,
      requestBodyValues: { model: MODEL },
    });
    expect(error.url.endsWith('/accounts/{account_id}/ai/run/@cf/cloudflare/clef-flash')).toBe(true);
    expect(error.data).toEqual({
      provider: 'cloudflare',
      code: 3030,
      message: 'Request requires 51796 tokens; the maximum is 24576',
      requestId: RAY,
      neurons: null,
    });

    const withoutRay = (await attemptWith(cfFailure(422, 3030, OVER_CONTEXT))) as APICallError;
    expect(withoutRay.data).toMatchObject({ requestId: '1e50b5c4-37d8-473a-b7a4-8afaf3423bf6' });
  });

  it('scrubs the account id from error text', async () => {
    const error = (await attemptWith(
      cfFailure(400, 7003, `Could not route to /client/v4/accounts/${ACCT}/ai/run, perhaps your object identifier is invalid?`),
    )) as APICallError;
    expect(error.message).toContain('{account_id}');
    expect(error.message).not.toContain(ACCT);
    expect(error.responseBody).toContain('{account_id}');
    expect(error.responseBody).not.toContain(ACCT);
    expect(error.url).not.toContain(ACCT);
    expect(JSON.stringify(error.data)).not.toContain(ACCT);
  });

  it('turns unusable 2xx bodies into a 502', async () => {
    for (const body of [JSON.stringify({ success: false }), JSON.stringify({ success: true, result: null }), 'not json']) {
      const error = await attemptWith(new Response(body, { status: 200, headers: PROBE_HEADERS }));
      expect(error, body).toMatchObject({
        statusCode: 502,
        isRetryable: false,
        message: 'Cloudflare Workers AI returned an unusable response.',
      });
      expect((error as APICallError).data).toEqual({
        provider: 'cloudflare',
        code: null,
        message: null,
        requestId: REQ_ID,
        neurons: 0.77,
      });
    }
  });

  it('maps a dropped connection to a retryable error', async () => {
    run.mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }));
    const error = await rejection(postCloudflareOnce(snapshot, MODEL, {}, new AbortController().signal));
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ isRetryable: true, message: 'Cannot connect to API: ECONNRESET' });
    expect((error as APICallError).data).toEqual({
      provider: 'cloudflare',
      code: null,
      message: null,
      requestId: null,
      neurons: null,
    });
  });

  it('rethrows aborts untouched', async () => {
    const timeout = new DOMException('t', 'TimeoutError');
    run.mockRejectedValueOnce(timeout);
    await expect(rejection(postCloudflareOnce(snapshot, MODEL, {}, new AbortController().signal))).resolves.toBe(
      timeout,
    );
    const unregistered = new CloudflareModelNotRegisteredError('@cf/cloudflare/nope');
    run.mockRejectedValueOnce(unregistered);
    await expect(rejection(postCloudflareOnce(snapshot, MODEL, {}, new AbortController().signal))).resolves.toBe(
      unregistered,
    );
  });
});

describe('billed but unusable responses (U1)', () => {
  it('meters a billed 2xx Sophy could not use, and nothing Cloudflare rejected', async () => {
    const billed = await attemptWith(new Response('not json', { status: 200, headers: PROBE_HEADERS }));
    const info = cloudflareErrorInfo(billed);
    expect(info).toEqual({
      provider: 'cloudflare',
      code: null,
      message: null,
      requestId: REQ_ID,
      neurons: 0.77,
      statusCode: 502,
    });
    expect(cloudflareCostUsd({ model: MODEL, neurons: info!.neurons, inputTokens: 0, outputTokens: 0 })).toBe(
      0.000008,
    );

    // No neurons header on the 2xx: nothing to meter.
    const unpriced = await attemptWith(new Response('{"success":false}', { status: 200 }));
    expect(cloudflareErrorInfo(unpriced)?.neurons).toBeNull();
    // Rejected responses keep null, header or not.
    const rejected = await attemptWith(cfFailure(503, 0, 'x', { 'cf-ai-neurons': '0.77' }));
    expect(cloudflareErrorInfo(rejected)?.neurons).toBeNull();
    run.mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }));
    const dropped = await rejection(postCloudflareOnce(snapshot, MODEL, {}, new AbortController().signal));
    expect(cloudflareErrorInfo(dropped)?.neurons).toBeNull();
  });

  it('keeps a deadline that fires mid-body a timeout, carrying the billed data', async () => {
    const deadline = new AbortController();
    const reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    run.mockImplementation(async (_model, _body, signal) => stalledSuccess(signal));
    const pending = rejection(callCloudflareModel(snapshot, MODEL, {}, deadline.signal));
    await new Promise((resolve) => setTimeout(resolve, 0)); // the body read is now in flight
    deadline.abort(reason);
    const error = await pending;

    // Still the abort it was: not retried, recorded as a timeout, a 502 for the client.
    expect(run).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(Error);
    expect(APICallError.isInstance(error)).toBe(false);
    expect(error).toMatchObject({ name: 'TimeoutError', message: reason.message });
    expect(safeGatewayErrorMessage(error)).toBe('upstream_timeout');
    const response = upstreamErrorResponse(error, FALLBACK);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatchObject({ code: 'upstream_error', message: FALLBACK });

    // ...whose cause holds the billed data, and the original reason after it.
    expect(cloudflareErrorInfo(error)).toEqual({
      provider: 'cloudflare',
      code: null,
      message: null,
      requestId: REQ_ID,
      neurons: 0.77,
      statusCode: undefined,
    });
    expect(cloudflareCredentialFailure(error)).toBeNull();
    const carrier = (error as Error).cause;
    expect(APICallError.isInstance(carrier)).toBe(true);
    expect((carrier as APICallError).cause).toBe(reason);
    expect(JSON.stringify(carrier)).not.toContain(ACCT);
  });

  it('rethrows an abort reason that is not an Error as it came', async () => {
    const deadline = new AbortController();
    run.mockImplementation(async (_model, _body, signal) => stalledSuccess(signal));
    const pending = rejection(postCloudflareOnce(snapshot, MODEL, {}, deadline.signal));
    await new Promise((resolve) => setTimeout(resolve, 0));
    deadline.abort('client went away');
    await expect(pending).resolves.toBe('client went away');
  });
});

describe('callCloudflareModel retries', () => {
  it('retries a 429/3040 once capacity frees up', async () => {
    vi.useFakeTimers();
    run
      .mockResolvedValueOnce(cfFailure(429, 3040, 'Capacity temporarily exceeded'))
      .mockResolvedValueOnce(cfSuccess());
    const pending = callCloudflareModel(snapshot, MODEL, {}, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ neurons: 0.77, upstreamRequestId: REQ_ID });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 429/3036', async () => {
    vi.useFakeTimers();
    run.mockImplementation(async () =>
      cfFailure(
        429,
        3036,
        "AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan",
      ),
    );
    const error = await rejection(callCloudflareModel(snapshot, MODEL, {}, new AbortController().signal));
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ statusCode: 429, isRetryable: false, data: { code: 3036 } });
  });

  it('does not retry a 401', async () => {
    run.mockImplementation(async () => cfFailure(401, 10000, 'Authentication error'));
    const error = await rejection(callCloudflareModel(snapshot, MODEL, {}, new AbortController().signal));
    expect(run).toHaveBeenCalledOnce();
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ statusCode: 401, isRetryable: false });
  });

  it('gives up after three 5xx attempts', async () => {
    vi.useFakeTimers();
    run.mockImplementation(async () => cfFailure(503, 0, 'upstream unavailable'));
    const pending = rejection(callCloudflareModel(snapshot, MODEL, {}, new AbortController().signal));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    const error = await pending;
    expect(RetryError.isInstance(error)).toBe(true);
    expect(((error as RetryError).lastError as APICallError).statusCode).toBe(503);
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe('credential failures and request ids', () => {
  it('classifies credential failures through wrappers', async () => {
    const unauthorized = await attemptWith(
      cfFailure(401, 10000, 'Authentication error', { 'cf-ai-req-id': REQ_ID }),
    );
    expect(cloudflareCredentialFailure(unauthorized)).toBe('invalid');
    expect(cloudflareCredentialFailure(await attemptWith(cfFailure(403, 10000, 'Authentication error')))).toBe(
      'invalid',
    );
    expect(cloudflareCredentialFailure(await attemptWith(cfFailure(403, 3023, 'account blocked')))).toBeNull();

    const retried = new RetryError({
      message: 'x',
      reason: 'errorNotRetryable',
      errors: [await attemptWith(cfFailure(503, 0, 'down')), unauthorized],
    });
    expect(cloudflareCredentialFailure(retried)).toBe('invalid');
    const wrapped = new ProjectCloudflareUnavailableError(PROJECT, 'credential_invalid', ROW_A, unauthorized);
    expect(cloudflareCredentialFailure(wrapped)).toBe('invalid');
    expect(cloudflareErrorRequestId(wrapped)).toBe(REQ_ID);

    const vercel401 = new APICallError({
      message: 'Unauthorized',
      url: 'https://ai-gateway.vercel.sh/v1/evaluate',
      requestBodyValues: {},
      statusCode: 401,
      isRetryable: false,
    });
    expect(cloudflareCredentialFailure(vercel401)).toBeNull();
    expect(cloudflareErrorInfo(vercel401)).toBeNull();
  });
});

describe('cost (D6)', () => {
  const cost = (model: string, neurons: number | null, inputTokens = 0) =>
    cloudflareCostUsd({ model, neurons, inputTokens, outputTokens: 0 });

  it('prices neurons first, then registry tokens', () => {
    expect(cost(MODEL, 0.77)).toBe(0.000008);
    expect(cost('@cf/cloudflare/clairic', 1000)).toBe(0.011);
    expect(cost('@cf/cloudflare/clef', 12345.6)).toBe(0.135802);
    expect(cost('@cf/cloudflare/clef', 0.04)).toBe(0);
    expect(cost('@cf/cloudflare/clef', 0, 51796)).toBe(0); // a present header wins, even with tokens
    expect(cost('@cf/cloudflare/clef-flash', null, 222)).toBe(0.000008);
    expect(cost('@cf/cloudflare/clairic', null, 715)).toBe(0.000072);
    expect(cost('@cf/cloudflare/clef', null, 51796)).toBe(0.012431);
    expect(cost('@cf/cloudflare/clef-omni', null, 1000)).toBe(0.00015);
    expect(cost('@cf/cloudflare/clef', null, 1_000_000)).toBe(0.24);
    expect(cost('@cf/cloudflare/clef', null, Number.NaN)).toBe(0);
    expect(() => cost('@cf/cloudflare/nope', 1)).toThrow(CloudflareModelNotRegisteredError);
  });

  it('rounds to six decimals', () => {
    expect(roundUsd6(0.0000025)).toBe(0.000003);
    expect(String(roundUsd6(8.47e-6))).toBe('0.000008');
    expect(WORKERS_AI_USD_PER_1K_NEURONS).toBe(0.011);
  });
});
