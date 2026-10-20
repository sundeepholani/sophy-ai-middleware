import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyKey: vi.fn(),
  checkRateLimit: vi.fn(),
  costUsedThisMonth: vi.fn(),
  resolveProjectGateway: vi.fn(),
  resolveProjectCloudflare: vi.fn(),
  assessmentCapability: vi.fn(),
  handleAssessment: vi.fn(),
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
vi.mock('@/lib/gateway/project-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/project-provider')>()),
  resolveProjectGateway: mocks.resolveProjectGateway,
}));
vi.mock('@/lib/gateway/cloudflare-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/cloudflare-provider')>()),
  resolveProjectCloudflare: mocks.resolveProjectCloudflare,
}));
vi.mock('@/lib/gateway/assessments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/assessments')>()),
  assessmentCapability: mocks.assessmentCapability,
  handleAssessment: mocks.handleAssessment,
}));

import { POST } from '@/app/v1/evaluate/route';
import {
  ProjectCloudflareUnavailableError,
  ProjectGatewayUnavailableError,
} from '@/lib/gateway/project-provider';

const key = {
  id: '00000000-0000-4000-8000-000000000003',
  projectId: '00000000-0000-4000-8000-000000000001',
  name: 'Evaluation key',
  model: 'typesafe-ai/jev',
  systemPrompt: null,
  params: {},
  outputSchema: null,
  monthlyCostCapUsd: 100,
  rpmLimit: 60,
  logContent: true,
  status: 'active',
  knowledgebaseId: null,
};
const gateway = {
  projectId: key.projectId,
  gatewayCredentialId: '00000000-0000-4000-8000-000000000002',
};

const clefKey = { ...key, model: '@cf/cloudflare/clef' };
const cloudflare = {
  projectId: key.projectId,
  cloudflareCredentialId: '00000000-0000-4000-8000-000000000004',
  credentialRevision: 1,
  accountId: '0123456789abcdef0123456789abcdef',
  runner: { run: vi.fn() },
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

const BODY = {
  state: 'I was charged twice for my subscription.',
  questions: { refund: { type: 'boolean', instructions: 'Is a refund requested?' } },
};

function request(
  body: unknown = BODY,
  options: { authorization?: boolean; raw?: string } = {},
): Request {
  return new Request('https://sophy.test/v1/evaluate', {
    method: 'POST',
    headers: options.authorization === false ? undefined : { authorization: 'Bearer test-key' },
    body: options.raw ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyKey.mockResolvedValue(key);
  mocks.resolveProjectGateway.mockResolvedValue(gateway);
  mocks.resolveProjectCloudflare.mockResolvedValue(cloudflare);
  mocks.assessmentCapability.mockResolvedValue('assessment');
  mocks.checkRateLimit.mockResolvedValue({ ok: true });
  mocks.costUsedThisMonth.mockResolvedValue(0);
  mocks.handleAssessment.mockResolvedValue(Response.json({ accepted: true }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /v1/evaluate — authentication', () => {
  it('401s without a bearer token', async () => {
    const res = await POST(request(BODY, { authorization: false }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'missing_api_key' } });
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it('401s on an unknown key', async () => {
    mocks.verifyKey.mockResolvedValue(null);
    const res = await POST(request());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'invalid_api_key' } });
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });
});

describe('POST /v1/evaluate — body parsing', () => {
  it('400s on malformed JSON', async () => {
    const res = await POST(request(undefined, { raw: '{not json' }));
    expect(res.status).toBe(400);
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it('returns the typed 503 for a gateway key without a ready credential, before reading the body', async () => {
    mocks.resolveProjectGateway.mockRejectedValue(
      new ProjectGatewayUnavailableError(key.projectId, 'credential_missing'),
    );
    const res = await POST(request(undefined, { raw: '{not json' }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(NEUTRAL_503);
    expect(mocks.resolveProjectCloudflare).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it('400s on a non-object JSON body', async () => {
    const res = await POST(request(undefined, { raw: '[1,2,3]' }));
    expect(res.status).toBe(400);
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it('surfaces a parser rejection with its own code and param', async () => {
    const res = await POST(request({ questions: BODY.questions }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'missing_state', param: 'state' },
    });
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });
});

describe('POST /v1/evaluate — capability guard', () => {
  it('400s when the key model is positively known to be something else', async () => {
    mocks.assessmentCapability.mockResolvedValue('not_assessment');
    const res = await POST(request());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'model_not_evaluation' },
    });
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it('FAILS OPEN on an uncatalogued id or a catalog blip', async () => {
    // Evaluation models are new and the catalog memo is an hour long, so a
    // stale warm instance must not reject a freshly bound key. Do not tighten
    // this guard to `!== 'assessment'`.
    mocks.assessmentCapability.mockResolvedValue('unknown');
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(mocks.handleAssessment).toHaveBeenCalledOnce();
  });
});

describe('POST /v1/evaluate — limits', () => {
  it('429s with a retry-after when the rate limit is exceeded', async () => {
    mocks.checkRateLimit.mockResolvedValue({ ok: false, reset: Date.now() + 30_000 });
    const res = await POST(request());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it('402s when the monthly cost cap is reached', async () => {
    mocks.costUsedThisMonth.mockResolvedValue(100);
    const res = await POST(request());
    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'quota_exceeded' } });
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it('never reads spend when the key has no cap', async () => {
    mocks.verifyKey.mockResolvedValue({ ...key, monthlyCostCapUsd: null });
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(mocks.costUsedThisMonth).not.toHaveBeenCalled();
  });
});

describe('POST /v1/evaluate — happy path', () => {
  it('hands the key-owned context and the parsed request to the handler', async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledOnce();
    expect(mocks.costUsedThisMonth).toHaveBeenCalledWith(key.id);
    expect(mocks.handleAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: key.id, model: key.model, logContent: true }),
      expect.objectContaining({ state: BODY.state }),
    );
  });

  it('ignores a client-supplied model — the key owns it', async () => {
    await POST(request({ ...BODY, model: 'client/model-is-ignored' }));
    const [ctx] = mocks.handleAssessment.mock.calls[0];
    expect(ctx.model).toBe(key.model);
  });
});

describe('POST /v1/evaluate — Cloudflare Clef keys', () => {
  it("resolves only the project's Cloudflare credential and hands it to the handler", async () => {
    mocks.verifyKey.mockResolvedValue(clefKey);
    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(mocks.resolveProjectCloudflare).toHaveBeenCalledOnce();
    expect(mocks.resolveProjectCloudflare).toHaveBeenCalledWith(key.projectId);
    expect(mocks.resolveProjectGateway).not.toHaveBeenCalled();
    const [ctx] = mocks.handleAssessment.mock.calls[0];
    expect(ctx).toEqual({
      keyId: key.id,
      cloudflare,
      model: '@cf/cloudflare/clef',
      logContent: true,
    });
    expect(ctx).not.toHaveProperty('gateway');
  });

  it('returns the typed 503 when the Cloudflare credential is missing, even with a healthy Vercel key', async () => {
    mocks.verifyKey.mockResolvedValue(clefKey);
    mocks.resolveProjectCloudflare.mockRejectedValue(
      new ProjectCloudflareUnavailableError(key.projectId, 'credential_missing'),
    );
    const res = await POST(request());

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(NEUTRAL_503);
    expect(mocks.resolveProjectGateway).not.toHaveBeenCalled();
    expect(mocks.assessmentCapability).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it('returns the typed 503 for a Clef key without a Cloudflare credential, before reading the body', async () => {
    mocks.verifyKey.mockResolvedValue(clefKey);
    mocks.resolveProjectCloudflare.mockRejectedValue(
      new ProjectCloudflareUnavailableError(key.projectId, 'credential_missing'),
    );
    const res = await POST(request(undefined, { raw: '{not json' }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(NEUTRAL_503);
    expect(mocks.resolveProjectGateway).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it.each([
    'project_not_found',
    'project_inactive',
    'credential_unavailable',
    'credential_unchecked',
    'credential_invalid',
    'credential_billing_attention',
    'credential_misconfigured',
  ] as const)('uses the same neutral 503 for every Cloudflare resolver reason: %s', async (reason) => {
    mocks.verifyKey.mockResolvedValue(clefKey);
    mocks.resolveProjectCloudflare.mockRejectedValue(
      new ProjectCloudflareUnavailableError(key.projectId, reason),
    );
    const res = await POST(request());

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(NEUTRAL_503);
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it('falls back to the generic 503 on an unexpected Cloudflare resolver failure', async () => {
    mocks.verifyKey.mockResolvedValue(clefKey);
    mocks.resolveProjectCloudflare.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await POST(request());

      expect(res.status).toBe(503);
      const { error } = (await res.json()) as { error: { message: string; code: string } };
      expect(error.message).toBe('This project is temporarily unable to make AI requests.');
      expect(error.code).toBe('project_gateway_unavailable');
      // The provider is named; the error itself (and anything it carries) is not logged.
      expect(spy).toHaveBeenCalledWith('[gateway] project provider resolution failed', {
        projectId: key.projectId,
        provider: 'cloudflare',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('is not blocked by a Vercel credential outage', async () => {
    mocks.verifyKey.mockResolvedValue(clefKey);
    mocks.resolveProjectGateway.mockRejectedValue(
      new ProjectGatewayUnavailableError(key.projectId, 'credential_billing_attention'),
    );
    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(mocks.handleAssessment).toHaveBeenCalledOnce();
  });

  it('never resolves Cloudflare for a Vercel key', async () => {
    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(mocks.resolveProjectCloudflare).not.toHaveBeenCalled();
    expect(mocks.resolveProjectGateway).toHaveBeenCalledWith(key.projectId);
    const [ctx] = mocks.handleAssessment.mock.calls[0];
    expect(ctx).toEqual({ keyId: key.id, gateway, model: 'typesafe-ai/jev', logContent: true });
    expect(ctx).not.toHaveProperty('cloudflare');
  });

  it.each(['@cf/cloudflare/clairic', '@cf/cloudflare/unknown'])(
    'rejects Clairic and unregistered @cf/ keys through the real registry-first guard: %s',
    async (model) => {
      const fetchMock = vi.fn(async () => {
        throw new Error('no network in tests');
      });
      vi.stubGlobal('fetch', fetchMock);
      mocks.assessmentCapability.mockImplementation(async (m: string) =>
        (
          await vi.importActual<typeof import('@/lib/gateway/assessments')>('@/lib/gateway/assessments')
        ).assessmentCapability(m),
      );
      mocks.verifyKey.mockResolvedValue({ ...key, model });
      const res = await POST(request());

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: { code: 'model_not_evaluation' } });
      expect(mocks.assessmentCapability).toHaveBeenCalledWith(model);
      expect(mocks.handleAssessment).not.toHaveBeenCalled();
      expect(mocks.resolveProjectGateway).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  // Mirrors /v1/extract: a '@cf/' id that is not a registered evaluation model has no
  // credential to resolve, so a project without a healthy Cloudflare credential still
  // gets the documented 400, never the credential 503.
  it.each(['@cf/cloudflare/clairic', '@cf/cloudflare/unknown', '@cf/cloudflare/CLEF'])(
    'answers 400 model_not_evaluation for %s without resolving any credential',
    async (model) => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('no network in tests');
      }));
      mocks.assessmentCapability.mockImplementation(async (m: string) =>
        (
          await vi.importActual<typeof import('@/lib/gateway/assessments')>('@/lib/gateway/assessments')
        ).assessmentCapability(m),
      );
      mocks.resolveProjectCloudflare.mockRejectedValue(
        new ProjectCloudflareUnavailableError(key.projectId, 'credential_missing'),
      );
      mocks.verifyKey.mockResolvedValue({ ...key, model });
      const res = await POST(request());

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: {
          message: "This key's model is not an evaluation model.",
          type: 'invalid_request_error',
          param: null,
          code: 'model_not_evaluation',
        },
      });
      expect(mocks.resolveProjectCloudflare).not.toHaveBeenCalled();
      expect(mocks.resolveProjectGateway).not.toHaveBeenCalled();
      expect(mocks.checkRateLimit).not.toHaveBeenCalled();
      expect(mocks.handleAssessment).not.toHaveBeenCalled();
    },
  );

  it('never reaches the handler without a credential, even if the catalog guard fails open', async () => {
    // The guard is registry-first for '@cf/' ids; this pins the route's own backstop.
    mocks.assessmentCapability.mockResolvedValue('unknown');
    mocks.verifyKey.mockResolvedValue({ ...key, model: '@cf/cloudflare/clairic' });
    const res = await POST(request());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'model_not_evaluation' } });
    expect(mocks.resolveProjectCloudflare).not.toHaveBeenCalled();
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it("applies the Clef parse rules with the key's model", async () => {
    mocks.verifyKey.mockResolvedValue(clefKey);
    // The client's model is ignored: on a Jev key, an empty providerOptions would pass.
    const res = await POST(request({ ...BODY, model: 'typesafe-ai/jev', providerOptions: {} }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'unsupported_provider_options', param: 'providerOptions' },
    });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });

  it('passes a Clef pre-cap rejection through with its message', async () => {
    mocks.verifyKey.mockResolvedValue({ ...key, model: '@cf/cloudflare/clef-flash' });
    const res = await POST(
      request({
        state: 'x'.repeat(98_211),
        questions: { q: { type: 'boolean', instructions: 'Is it ok?' } },
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'state_too_large',
        param: 'state',
        message:
          'state is too large for Clef Flash: the request is estimated at 24577 tokens and the model accepts at most 24576.',
      },
    });
    expect(mocks.handleAssessment).not.toHaveBeenCalled();
  });
});
