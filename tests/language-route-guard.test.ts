import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The capability guard on the two language surfaces. These were the only POST
 * routes without one: a key bound to a transcription / embedding / image /
 * evaluation model used to blind-forward and fail opaquely — or, when
 * streaming, return HTTP 200 with an in-band error, because SSE headers commit
 * before the first upstream byte exists.
 */

const mocks = vi.hoisted(() => ({
  verifyKey: vi.fn(),
  checkRateLimit: vi.fn(),
  costUsedThisMonth: vi.fn(),
  resolveProjectGateway: vi.fn(),
  languageCapability: vi.fn(),
  handleNonStreaming: vi.fn(),
  handleStreaming: vi.fn(),
  handleResponsesNonStreaming: vi.fn(),
  handleResponsesStreaming: vi.fn(),
  systemPromptWithKb: vi.fn(),
  assertOwnedBlobs: vi.fn(),
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
// The importOriginal spread is mandatory here: models.ts is also imported by
// embeddings, images, assessments and transcriptions, and a bare factory would
// blank listAllModels / keyModelsFromCatalog for the whole file.
vi.mock('@/lib/gateway/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/models')>()),
  languageCapability: mocks.languageCapability,
}));
vi.mock('@/lib/gateway/project-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/project-provider')>()),
  resolveProjectGateway: mocks.resolveProjectGateway,
}));
vi.mock('@/lib/gateway/call', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/call')>()),
  handleNonStreaming: mocks.handleNonStreaming,
  handleStreaming: mocks.handleStreaming,
}));
vi.mock('@/lib/gateway/responses', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/responses')>()),
  handleResponsesNonStreaming: mocks.handleResponsesNonStreaming,
  handleResponsesStreaming: mocks.handleResponsesStreaming,
}));
vi.mock('@/lib/kb/retrieve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kb/retrieve')>()),
  systemPromptWithKb: mocks.systemPromptWithKb,
}));
vi.mock('@/lib/files/blob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/files/blob')>()),
  assertOwnedBlobs: mocks.assertOwnedBlobs,
}));

import { POST as chatPOST } from '@/app/v1/chat/completions/route';
import { POST as responsesPOST } from '@/app/v1/responses/route';

const key = {
  id: '00000000-0000-4000-8000-000000000003',
  projectId: '00000000-0000-4000-8000-000000000001',
  name: 'Chat key',
  model: 'openai/gpt-5-mini',
  systemPrompt: null,
  params: {},
  outputSchema: null,
  monthlyCostCapUsd: 100,
  rpmLimit: 60,
  logContent: false,
  status: 'active',
  knowledgebaseId: null,
};
const gateway = {
  projectId: key.projectId,
  gatewayCredentialId: '00000000-0000-4000-8000-000000000002',
};

function chatReq(body: unknown = { messages: [{ role: 'user', content: 'hi' }] }): Request {
  return new Request('https://sophy.test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer test-key' },
    body: JSON.stringify(body),
  });
}
function responsesReq(body: unknown = { input: 'hi' }): Request {
  return new Request('https://sophy.test/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer test-key' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyKey.mockResolvedValue(key);
  mocks.resolveProjectGateway.mockResolvedValue(gateway);
  mocks.languageCapability.mockResolvedValue('language');
  mocks.checkRateLimit.mockResolvedValue({ ok: true });
  mocks.costUsedThisMonth.mockResolvedValue(0);
  mocks.systemPromptWithKb.mockResolvedValue(null);
  mocks.assertOwnedBlobs.mockResolvedValue({ ok: true });
  mocks.handleNonStreaming.mockResolvedValue(Response.json({ ok: true }));
  mocks.handleStreaming.mockReturnValue(new Response('stream'));
  mocks.handleResponsesNonStreaming.mockResolvedValue(Response.json({ ok: true }));
  mocks.handleResponsesStreaming.mockReturnValue(new Response('stream'));
});

const SURFACES = [
  {
    name: 'POST /v1/chat/completions',
    post: chatPOST,
    req: chatReq,
    handler: mocks.handleNonStreaming,
  },
  {
    name: 'POST /v1/responses',
    post: responsesPOST,
    req: responsesReq,
    handler: mocks.handleResponsesNonStreaming,
  },
];

for (const surface of SURFACES) {
  describe(`${surface.name} — capability guard`, () => {
    it('400s model_not_language for a key the catalog knows is not a language model', async () => {
      mocks.languageCapability.mockResolvedValue('not_language');
      const res = await surface.post(surface.req());

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: { type: 'invalid_request_error', code: 'model_not_language' },
      });
      expect(surface.handler).not.toHaveBeenCalled();
    });

    it('rejects before the rate limiter, which is a write', async () => {
      // bumpWindow INSERTs and increments, so guarding after it would spend an
      // RPM token per rejected request and turn a retry loop into 429s.
      mocks.languageCapability.mockResolvedValue('not_language');
      await surface.post(surface.req());
      expect(mocks.checkRateLimit).not.toHaveBeenCalled();
      expect(mocks.costUsedThisMonth).not.toHaveBeenCalled();
    });

    it('rejects before the paid knowledgebase embed and the blob retention write', async () => {
      mocks.languageCapability.mockResolvedValue('not_language');
      await surface.post(surface.req());
      expect(mocks.systemPromptWithKb).not.toHaveBeenCalled();
      expect(mocks.assertOwnedBlobs).not.toHaveBeenCalled();
    });

    it('passes a catalogued language model through', async () => {
      const res = await surface.post(surface.req());
      expect(res.status).toBe(200);
      expect(surface.handler).toHaveBeenCalledOnce();
    });

    it("fails OPEN on an uncatalogued id or a catalog blip", async () => {
      // Custom/private/BYOK models are not in the public catalog. Do not
      // tighten this to `!== 'language'`.
      mocks.languageCapability.mockResolvedValue('unknown');
      const res = await surface.post(surface.req());
      expect(res.status).toBe(200);
      expect(surface.handler).toHaveBeenCalledOnce();
    });

    it("guards the key's model, never the client's", async () => {
      await surface.post(
        surface.req(
          surface.name.includes('chat')
            ? { model: 'client/ignored', messages: [{ role: 'user', content: 'hi' }] }
            : { model: 'client/ignored', input: 'hi' },
        ),
      );
      expect(mocks.languageCapability).toHaveBeenCalledWith(key.model);
    });
  });
}

describe('guard ordering vs the free sync rejects', () => {
  it('chat: a malformed request is rejected without paying for a catalog lookup', async () => {
    mocks.languageCapability.mockResolvedValue('not_language');
    const res = await chatPOST(chatReq({ messages: [] }));
    expect(res.status).toBe(400);
    expect(mocks.languageCapability).not.toHaveBeenCalled();
  });

  it('responses: previous_response_id still wins over the guard', async () => {
    mocks.languageCapability.mockResolvedValue('not_language');
    const res = await responsesPOST(responsesReq({ input: 'hi', previous_response_id: 'resp_1' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'stateful_unsupported' },
    });
    expect(mocks.languageCapability).not.toHaveBeenCalled();
  });
});
