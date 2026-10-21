import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyKey: vi.fn(),
  checkRateLimit: vi.fn(),
  costUsedThisMonth: vi.fn(),
  resolveProjectCloudflare: vi.fn(),
  resolveProjectGateway: vi.fn(),
  handleExtraction: vi.fn(),
}));

vi.mock('@/lib/auth/api-key', () => ({
  bearerFromHeader: (header: string | null) => {
    const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
    return match?.[1] ?? null;
  },
  verifyKey: mocks.verifyKey,
}));
vi.mock('@/lib/counters', () => ({
  checkRateLimit: mocks.checkRateLimit,
  costUsedThisMonth: mocks.costUsedThisMonth,
}));
vi.mock('@/lib/gateway/cloudflare-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/cloudflare-provider')>()),
  resolveProjectCloudflare: mocks.resolveProjectCloudflare,
}));
// Spy only: the route must never resolve the Vercel gateway (D3).
vi.mock('@/lib/gateway/project-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/project-provider')>()),
  resolveProjectGateway: mocks.resolveProjectGateway,
}));
// The real guard and parser run; only the upstream handler is replaced.
vi.mock('@/lib/gateway/extraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/extraction')>()),
  handleExtraction: mocks.handleExtraction,
}));

import * as route from '@/app/v1/extract/route';
import { ProjectCloudflareUnavailableError } from '@/lib/gateway/project-provider';

/**
 * POST /v1/extract — the route pipeline (D9; contract §2.13): authenticate →
 * resolve the Cloudflare credential (extraction keys only) → parse → guard →
 * validate → rate limit → quota → handler. Everything below the route is mocked
 * except the real guard and parser.
 */

const key = {
  id: '00000000-0000-4000-8000-000000000003',
  projectId: '00000000-0000-4000-8000-000000000001',
  name: 'Extraction key',
  model: '@cf/cloudflare/clairic',
  systemPrompt: null,
  params: {},
  outputSchema: null,
  monthlyCostCapUsd: 100,
  rpmLimit: 60,
  logContent: true,
  status: 'active',
  knowledgebaseId: null,
};
const snapshot = {
  projectId: key.projectId,
  cloudflareCredentialId: '00000000-0000-4000-8000-000000000004',
  credentialRevision: 1,
  accountId: '0123456789abcdef0123456789abcdef',
  runner: { run: vi.fn() },
};
const BODY = {
  state: 'Invoice INV-7731 from Blue Harbor Logistics.',
  fields: { invoice_number: { type: 'text', instructions: 'Invoice number' } },
};
const NEUTRAL_503 =
  'This project is not ready to make AI requests. Ask a project admin to connect or check its AI provider credentials.';
const NOT_EXTRACTION = {
  message: "This key's model is not an extraction model.",
  type: 'invalid_request_error',
  param: null,
  code: 'model_not_extraction',
};

function request(body: unknown = BODY, options: { authorization?: boolean; raw?: string } = {}): Request {
  return new Request('https://sophy.test/v1/extract', {
    method: 'POST',
    headers: options.authorization === false ? undefined : { authorization: 'Bearer test-key' },
    body: options.raw ?? JSON.stringify(body),
  });
}
const exportLines = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => /^export const (runtime|dynamic|maxDuration|preferredRegion) =/.test(line));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyKey.mockResolvedValue(key);
  mocks.resolveProjectCloudflare.mockResolvedValue(snapshot);
  mocks.checkRateLimit.mockResolvedValue({ ok: true });
  mocks.costUsedThisMonth.mockResolvedValue(0);
  mocks.handleExtraction.mockResolvedValue(Response.json({ accepted: true }));
});

describe('POST /v1/extract — segment config', () => {
  it('exports the same segment config as /v1/evaluate', () => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.maxDuration).toBe(800);
    expect(route.preferredRegion).toBe('bom1');
    // Text comparison: B1 edits the evaluate route in parallel, so never import it here.
    const extract = exportLines('../app/v1/extract/route.ts');
    expect(extract).toHaveLength(4);
    expect(extract).toEqual(exportLines('../app/v1/evaluate/route.ts'));
  });
});

describe('POST /v1/extract — authentication', () => {
  it('401s without a bearer token', async () => {
    const res = await route.POST(request(BODY, { authorization: false }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { message: 'Missing API key.', type: 'authentication_error', param: null, code: 'missing_api_key' },
    });
    expect(mocks.resolveProjectCloudflare).not.toHaveBeenCalled();
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });

  it('401s on an unknown key', async () => {
    mocks.verifyKey.mockResolvedValue(null);
    const res = await route.POST(request());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { message: 'Invalid API key.', type: 'authentication_error', param: null, code: 'invalid_api_key' },
    });
    expect(mocks.resolveProjectCloudflare).not.toHaveBeenCalled();
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });
});

describe('POST /v1/extract — credential resolution', () => {
  it('resolves only the project Cloudflare credential, never the Vercel gateway', async () => {
    const res = await route.POST(request());
    expect(res.status).toBe(200);
    expect(mocks.resolveProjectCloudflare).toHaveBeenCalledOnce();
    expect(mocks.resolveProjectCloudflare).toHaveBeenCalledWith(key.projectId);
    expect(mocks.resolveProjectGateway).not.toHaveBeenCalled();
  });

  it('returns the typed 503 for a Clairic key without a Cloudflare credential, before reading the body', async () => {
    mocks.resolveProjectCloudflare.mockRejectedValue(
      new ProjectCloudflareUnavailableError(key.projectId, 'credential_missing'),
    );
    const res = await route.POST(request(undefined, { raw: '{not json' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({
      error: { message: NEUTRAL_503, type: 'api_error', param: null, code: 'project_gateway_unavailable' },
    });
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.resolveProjectGateway).not.toHaveBeenCalled();
  });

  it('maps an unexpected resolution failure to the generic 503', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.resolveProjectCloudflare.mockRejectedValue(new Error('db down'));
      const res = await route.POST(request());
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({
        error: {
          message: 'This project is temporarily unable to make AI requests.',
          type: 'api_error',
          param: null,
          code: 'project_gateway_unavailable',
        },
      });
      expect(consoleError).toHaveBeenCalledWith('[cloudflare] project credential resolution failed', {
        projectId: key.projectId,
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('db down');
      expect(mocks.handleExtraction).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /v1/extract — capability guard', () => {
  it('rejects a Jev key with model_not_extraction without resolving any credential', async () => {
    mocks.verifyKey.mockResolvedValue({ ...key, model: 'typesafe-ai/jev' });
    const res = await route.POST(request());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: NOT_EXTRACTION });
    expect(mocks.resolveProjectCloudflare).not.toHaveBeenCalled();
    expect(mocks.resolveProjectGateway).not.toHaveBeenCalled();
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });

  it('rejects a Clef key with model_not_extraction without resolving its credential', async () => {
    // Even with the project's Cloudflare credential missing, the answer is the 400, not a 503.
    mocks.resolveProjectCloudflare.mockRejectedValue(
      new ProjectCloudflareUnavailableError(key.projectId, 'credential_missing'),
    );
    for (const model of ['@cf/cloudflare/clef', '@cf/cloudflare/clef-flash', '@cf/cloudflare/clef-omni']) {
      mocks.verifyKey.mockResolvedValue({ ...key, model });
      const res = await route.POST(request());
      expect(res.status, model).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: NOT_EXTRACTION });
    }
    expect(mocks.resolveProjectCloudflare).not.toHaveBeenCalled();
    expect(mocks.resolveProjectGateway).not.toHaveBeenCalled();
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });

  it('fails closed for an unregistered @cf/ id', async () => {
    mocks.verifyKey.mockResolvedValue({ ...key, model: '@cf/cloudflare/clairic-2' });
    const res = await route.POST(request());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: NOT_EXTRACTION });
    expect(mocks.resolveProjectCloudflare).not.toHaveBeenCalled();
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });

  it('checks the model before validating the body', async () => {
    mocks.verifyKey.mockResolvedValue({ ...key, model: 'typesafe-ai/jev' });
    const res = await route.POST(request({}));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'model_not_extraction' } });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('POST /v1/extract — body parsing', () => {
  it('400s on malformed JSON', async () => {
    const res = await route.POST(request(undefined, { raw: '{not json' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { message: 'Request body must be valid JSON.', type: 'invalid_request_error', param: null, code: null },
    });
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });

  it('400s on a non-object JSON body', async () => {
    for (const raw of ['[1,2,3]', 'null', '"text"', '42']) {
      const res = await route.POST(request(undefined, { raw }));
      expect(res.status, raw).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: { message: 'Request body must be a JSON object.', code: null },
      });
    }
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });
});

describe('POST /v1/extract — validation', () => {
  it('surfaces a parser rejection with its code and param before any limit is consumed', async () => {
    const res = await route.POST(request({ state: 'x' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        message: 'Missing required parameter: fields.',
        type: 'invalid_request_error',
        param: 'fields',
        code: 'missing_fields',
      },
    });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.costUsedThisMonth).not.toHaveBeenCalled();
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });

  it('refuses Cloudflare-native images with the media-field rule', async () => {
    const res = await route.POST(request({ ...BODY, images: [] }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'unsupported_media_field', param: 'images' },
    });
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });

  it('rejects a field spec with an unknown key, naming the exact param', async () => {
    const res = await route.POST(request({ ...BODY, fields: { total: { type: 'number', currency: 'USD' } } }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        message: 'fields.total.currency is not a supported field option.',
        type: 'invalid_request_error',
        param: 'fields.total.currency',
        code: 'invalid_field',
      },
    });
  });
});

describe('POST /v1/extract — limits', () => {
  it('429s with a retry-after when the rate limit is exceeded', async () => {
    mocks.checkRateLimit.mockResolvedValue({ ok: false, reset: Date.now() + 30_000 });
    const res = await route.POST(request());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    await expect(res.json()).resolves.toEqual({
      error: { message: 'Rate limit exceeded.', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' },
    });
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });

  it('402s when the monthly cost cap is reached', async () => {
    mocks.costUsedThisMonth.mockResolvedValue(100);
    const res = await route.POST(request());
    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toEqual({
      error: {
        message: 'Monthly cost budget exceeded.',
        type: 'insufficient_quota',
        param: null,
        code: 'quota_exceeded',
      },
    });
    expect(mocks.handleExtraction).not.toHaveBeenCalled();
  });

  it('never reads spend when the key has no cap', async () => {
    mocks.verifyKey.mockResolvedValue({ ...key, monthlyCostCapUsd: null });
    const res = await route.POST(request());
    expect(res.status).toBe(200);
    expect(mocks.costUsedThisMonth).not.toHaveBeenCalled();
  });
});

describe('POST /v1/extract — happy path', () => {
  it('hands the key-owned context, the Cloudflare snapshot and the parsed request to the handler', async () => {
    const res = await route.POST(request());
    expect(res.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(key.id, key.rpmLimit);
    expect(mocks.costUsedThisMonth).toHaveBeenCalledWith(key.id);
    expect(mocks.handleExtraction).toHaveBeenCalledOnce();
    expect(mocks.handleExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: key.id, model: key.model, logContent: true, cloudflare: snapshot }),
      expect.objectContaining({ state: BODY.state, fields: BODY.fields, options: {} }),
    );
  });

  it('ignores a client-supplied model — the key owns it', async () => {
    await route.POST(request({ ...BODY, model: 'openai/gpt-5' }));
    expect(mocks.handleExtraction.mock.calls[0][0].model).toBe(key.model);
  });
});
