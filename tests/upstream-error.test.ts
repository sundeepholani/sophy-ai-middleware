import { describe, it, expect } from 'vitest';
import { APICallError } from 'ai';
import { mapUpstreamError, upstreamErrorResponse } from '@/lib/gateway/upstream-error';

const FALLBACK = 'Upstream model request failed.';

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
  function apiError(statusCode: number, message: string, headers?: Record<string, string>) {
    return new APICallError({
      message,
      url: 'https://gateway.example/v1',
      requestBodyValues: {},
      statusCode,
      responseHeaders: headers,
      responseBody: message,
      isRetryable: statusCode === 429,
    });
  }

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
