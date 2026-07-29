import { describe, it, expect } from 'vitest';
import {
  createGateway,
  GatewayInternalServerError,
  GatewayRateLimitError,
} from '@ai-sdk/gateway';
import { APICallError, generateText, RetryError } from 'ai';
import {
  createGateway as createTranscriptionGateway,
  GatewayError as TranscriptionGatewayError,
  GatewayInvalidRequestError as TranscriptionGatewayInvalidRequestError,
} from 'ai-gateway-v4';
import { transcribe } from 'ai-v7';
import {
  mapUpstreamError,
  safeGatewayErrorMessage,
  upstreamErrorResponse,
} from '@/lib/gateway/upstream-error';

const FALLBACK = 'Upstream model request failed.';

function apiError(statusCode: number, message: string, headers?: Record<string, string>) {
  return new APICallError({
    message,
    url: 'https://gateway.example/v1',
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    responseBody: message,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

describe('mapUpstreamError (pure)', () => {
  it('maps a 400 client-input rejection to 400 invalid_request and ECHOES the provider detail', () => {
    const m = mapUpstreamError(
      400,
      'messages.0.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels',
      FALLBACK,
    );
    expect(m.status).toBe(400);
    expect(m.type).toBe('invalid_request_error');
    expect(m.code).toBe('upstream_invalid_request');
    expect(m.message).toContain('image dimensions exceed max allowed size: 8000 pixels');
    expect(m.passRetryAfter).toBe(false);
  });

  it('treats 413 and 422 as client-input rejections too', () => {
    expect(mapUpstreamError(413, 'too large', FALLBACK).status).toBe(400);
    expect(mapUpstreamError(422, 'unprocessable', FALLBACK).type).toBe('invalid_request_error');
  });

  it('maps 429 to a rate_limit_error with a GENERIC message (never echoes account internals)', () => {
    const leaky =
      'Quota limit exceeded for "api_key_id_aDXYtQweGc4GPF0Np4y5uhXaZLHyOQprMDPCys6LtIoEssWC". Current spend: $32.75, limit: $30.00.';
    const m = mapUpstreamError(429, leaky, FALLBACK);
    expect(m.status).toBe(429);
    expect(m.type).toBe('rate_limit_error');
    expect(m.passRetryAfter).toBe(true);
    expect(m.message).not.toContain('api_key_id_');
    expect(m.message).not.toContain('$32.75');
  });

  it('maps 402 to insufficient_quota with a GENERIC message (never echoes the top-up URL)', () => {
    const leaky =
      'A positive credit balance is required... Add credits at https://vercel.com/d?to=%2F%5Bteam%5D to continue.';
    const m = mapUpstreamError(402, leaky, FALLBACK);
    expect(m.status).toBe(402);
    expect(m.type).toBe('insufficient_quota');
    expect(m.message).not.toContain('vercel.com');
  });

  it('keeps the opaque 502 for auth/permission/not-found/5xx/unknown', () => {
    for (const code of [undefined, 401, 403, 404, 500, 502, 503]) {
      const m = mapUpstreamError(code, 'whatever upstream said', FALLBACK);
      expect(m.status).toBe(502);
      expect(m.type).toBe('api_error');
      expect(m.code).toBe('upstream_error');
      expect(m.message).toBe(FALLBACK);
    }
  });

  it('caps an over-long echoed client message', () => {
    const long = 'x'.repeat(1000);
    const m = mapUpstreamError(400, long, FALLBACK);
    expect(m.message.length).toBeLessThan(1000);
    expect(m.message.endsWith('…')).toBe(true);
  });

  it('falls back when a client-input rejection carries no message', () => {
    const m = mapUpstreamError(400, '   ', FALLBACK);
    expect(m.message).toBe('The request was rejected by the upstream model provider.');
  });
});

describe('upstreamErrorResponse (wraps an AI SDK APICallError)', () => {
  it('returns a 400 body with the echoed image error for the reproduced cluster', async () => {
    const res = upstreamErrorResponse(
      apiError(400, 'At least one of the image dimensions exceed max allowed size: 8000 pixels'),
      FALLBACK,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('8000 pixels');
  });

  it('forwards Retry-After on a 429 and does not leak the upstream quota text', async () => {
    const res = upstreamErrorResponse(
      apiError(429, 'Quota limit exceeded for "api_key_id_secret". Current spend: $32.75', { 'retry-after': '7' }),
      FALLBACK,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    const body = await res.json();
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).not.toContain('api_key_id_secret');
  });

  it('falls back to 502 for a non-APICallError (plain Error, no status)', async () => {
    const res = upstreamErrorResponse(new Error('socket hang up'), FALLBACK);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toBe(FALLBACK);
    expect(body.error.message).not.toContain('socket hang up');
  });
});

describe('explicit Gateway provider errors', () => {
  it('preserves a real explicit-provider 400 instead of flattening it to 502', async () => {
    let calls = 0;
    const gateway = createGateway({
      apiKey: 'test-gateway-key',
      baseURL: 'https://gateway.example/v1/ai',
      fetch: async () => {
        calls += 1;
        return Response.json(
          {
            error: {
              type: 'internal_server_error',
              message: 'The request parameter was rejected.',
            },
            generationId: 'gen_internal_123',
          },
          { status: 400 },
        );
      },
    });
    const error = await generateText({
      model: gateway.languageModel('openai/gpt-5.4-nano'),
      prompt: 'test',
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(calls).toBe(1);
    expect(GatewayInternalServerError.isInstance(error)).toBe(true);
    if (!GatewayInternalServerError.isInstance(error)) throw new Error('Expected gateway error');
    expect(error.message).toContain('[gen_internal_123]');
    expect(safeGatewayErrorMessage(error)).toBe('upstream_http_400');
    const response = upstreamErrorResponse(error, FALLBACK);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'upstream_invalid_request',
        message: 'The request parameter was rejected.',
      },
    });
    expect(body.error.message).not.toContain('gen_internal_123');
  });

  it('unwraps a retried GatewayError 429 and preserves Retry-After safely', async () => {
    const leaky = 'Quota exceeded for api_key_id_secret with $32.75 spend.';
    const gatewayError = new GatewayRateLimitError({
      message: leaky,
      statusCode: 429,
      cause: apiError(429, leaky, { 'Retry-After': '7' }),
    });
    const error = new RetryError({
      message: 'Failed after 3 attempts.',
      reason: 'maxRetriesExceeded',
      errors: [gatewayError, gatewayError, gatewayError],
    });

    expect(safeGatewayErrorMessage(error)).toBe('upstream_http_429');
    const response = upstreamErrorResponse(error, FALLBACK);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    const body = await response.json();
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).not.toContain('api_key_id_secret');
    expect(body.error.message).not.toContain('$32.75');
  });

  it('keeps a retried GatewayError 500 opaque while recording its status', async () => {
    const gatewayError = new GatewayInternalServerError({
      message: 'Internal provider detail.',
      statusCode: 500,
      cause: apiError(500, 'Internal provider detail.'),
    });
    const error = new RetryError({
      message: 'Failed after 3 attempts.',
      reason: 'maxRetriesExceeded',
      errors: [gatewayError, gatewayError, gatewayError],
    });

    expect(safeGatewayErrorMessage(error)).toBe('upstream_http_500');
    const response = upstreamErrorResponse(error, FALLBACK);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe('upstream_error');
    expect(body.error.message).toBe(FALLBACK);
    expect(body.error.message).not.toContain('Internal provider detail.');
  });
});

describe('Gateway v4 transcription errors', () => {
  const wav = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
  ]);

  it('preserves a real transcription-provider 400 and removes its generation id', async () => {
    const gateway = createTranscriptionGateway({
      apiKey: 'test-gateway-key',
      baseURL: 'https://gateway.example/v1/ai',
      fetch: async () =>
        Response.json(
          {
            error: {
              type: 'invalid_request_error',
              message: 'Unsupported audio container.',
            },
            generationId: 'gen_transcription_400',
          },
          { status: 400 },
        ),
    });
    const error = await transcribe({
      model: gateway.transcriptionModel('openai/gpt-4o-mini-transcribe'),
      audio: wav,
      maxRetries: 0,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(TranscriptionGatewayInvalidRequestError.isInstance(error)).toBe(true);
    expect(safeGatewayErrorMessage(error)).toBe('upstream_http_400');
    const response = upstreamErrorResponse(error, 'The transcription request failed.');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: 'upstream_invalid_request',
        message: 'Unsupported audio container.',
      },
    });
    expect(body.error.message).not.toContain('gen_transcription_400');
  });

  it('preserves Retry-After on a real transcription-provider 429 without leaking detail', async () => {
    const gateway = createTranscriptionGateway({
      apiKey: 'test-gateway-key',
      baseURL: 'https://gateway.example/v1/ai',
      fetch: async () =>
        Response.json(
          {
            error: {
              type: 'rate_limit_error',
              message: 'Quota for api_key_id_secret is exhausted at $91.50.',
            },
            generationId: 'gen_transcription_429',
          },
          { status: 429, headers: { 'retry-after': '9' } },
        ),
    });
    const error = await transcribe({
      model: gateway.transcriptionModel('openai/gpt-4o-mini-transcribe'),
      audio: wav,
      maxRetries: 0,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    // Gateway currently uses an internal-server subclass for this response
    // shape, but retains the real 429. Mapping must follow the status, not the
    // subclass name.
    expect(TranscriptionGatewayError.isInstance(error)).toBe(true);
    expect((error as { statusCode?: number }).statusCode).toBe(429);
    expect(safeGatewayErrorMessage(error)).toBe('upstream_http_429');
    const response = upstreamErrorResponse(error, 'The transcription request failed.');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('9');
    const body = await response.json();
    expect(body.error.message).not.toContain('api_key_id_secret');
    expect(body.error.message).not.toContain('$91.50');
  });
});
