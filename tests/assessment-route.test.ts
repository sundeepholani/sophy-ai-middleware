import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyKey: vi.fn(),
  checkRateLimit: vi.fn(),
  costUsedThisMonth: vi.fn(),
  resolveProjectGateway: vi.fn(),
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
vi.mock('@/lib/gateway/assessments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/assessments')>()),
  assessmentCapability: mocks.assessmentCapability,
  handleAssessment: mocks.handleAssessment,
}));

import { POST } from '@/app/v1/evaluate/route';

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
  mocks.assessmentCapability.mockResolvedValue('assessment');
  mocks.checkRateLimit.mockResolvedValue({ ok: true });
  mocks.costUsedThisMonth.mockResolvedValue(0);
  mocks.handleAssessment.mockResolvedValue(Response.json({ accepted: true }));
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
