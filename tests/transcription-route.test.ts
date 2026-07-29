import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyKey: vi.fn(),
  checkRateLimit: vi.fn(),
  costUsedThisMonth: vi.fn(),
  resolveProjectGateway: vi.fn(),
  transcriptionCapability: vi.fn(),
  processorCapability: vi.fn(),
  handleTranscription: vi.fn(),
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
vi.mock('@/lib/gateway/transcriptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/transcriptions')>()),
  transcriptionCapability: mocks.transcriptionCapability,
  processorCapability: mocks.processorCapability,
  handleTranscription: mocks.handleTranscription,
}));

import { POST } from '@/app/v1/audio/transcriptions/route';
import { MAX_MULTIPART_BODY_BYTES } from '@/lib/gateway/transcriptions';

const key = {
  id: '00000000-0000-4000-8000-000000000003',
  projectId: '00000000-0000-4000-8000-000000000001',
  name: 'Transcription key',
  model: 'openai/gpt-4o-mini-transcribe',
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
const wav = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
]);

function request(options: {
  key?: typeof key;
  fields?: Record<string, string>;
  authorization?: boolean;
} = {}): Request {
  const form = new FormData();
  form.set('file', new File([wav], 'meeting.wav', { type: 'audio/wav' }));
  for (const [name, value] of Object.entries(options.fields ?? {})) form.set(name, value);
  return new Request('https://sophy.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: options.authorization === false ? undefined : { authorization: 'Bearer test-key' },
    body: form,
  });
}

function streamingRequest(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://sophy.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'multipart/form-data; boundary=test',
      ...headers,
    },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyKey.mockResolvedValue(key);
  mocks.resolveProjectGateway.mockResolvedValue(gateway);
  mocks.transcriptionCapability.mockResolvedValue('transcription');
  mocks.processorCapability.mockResolvedValue('language');
  mocks.checkRateLimit.mockResolvedValue({ ok: true });
  mocks.costUsedThisMonth.mockResolvedValue(0);
  mocks.handleTranscription.mockResolvedValue(Response.json({ accepted: true }));
});

describe('POST /v1/audio/transcriptions', () => {
  it('requires a bearer key and multipart content', async () => {
    const missingKey = await POST(request({ authorization: false }));
    expect(missingKey.status).toBe(401);
    await expect(missingKey.json()).resolves.toMatchObject({
      error: { code: 'missing_api_key' },
    });

    const wrongContent = await POST(
      new Request('https://sophy.test/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-key',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect(wrongContent.status).toBe(400);
    await expect(wrongContent.json()).resolves.toMatchObject({
      error: { code: 'invalid_content_type' },
    });
  });

  it('rejects an oversized multipart body before buffering it', async () => {
    const response = await POST(
      new Request('https://sophy.test/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-key',
          'content-type': 'multipart/form-data; boundary=test',
          'content-length': '4500001',
        },
        body: '--test--',
      }),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'file_too_large' },
    });
  });

  it('enforces the multipart body limit when Content-Length is missing', async () => {
    let pull = 0;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pull += 1;
          if (pull === 1) {
            controller.enqueue(new Uint8Array(MAX_MULTIPART_BODY_BYTES));
          } else {
            controller.enqueue(Uint8Array.of(0));
          }
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 },
    );
    const req = streamingRequest(body);
    expect(req.headers.has('content-length')).toBe(false);

    const response = await POST(req);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'file_too_large' },
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(mocks.handleTranscription).not.toHaveBeenCalled();
  });

  it('preserves a case-sensitive multipart boundary while parsing', async () => {
    const boundary = 'BoundaryABC';
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="meeting.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    );
    const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(prefix.length + wav.length + suffix.length);
    body.set(prefix);
    body.set(wav, prefix.length);
    body.set(suffix, prefix.length + wav.length);

    const response = await POST(
      new Request('https://sophy.test/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-key',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.handleTranscription).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        file: expect.objectContaining({ name: 'meeting.wav', format: 'wav' }),
      }),
    );
  });

  it('rejects a known non-transcription key before rate limiting or a paid call', async () => {
    mocks.transcriptionCapability.mockResolvedValue('not_transcription');
    const response = await POST(request());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'model_not_transcription' },
    });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.handleTranscription).not.toHaveBeenCalled();
  });

  it('fails closed when a system prompt has no processor model', async () => {
    mocks.verifyKey.mockResolvedValue({
      ...key,
      systemPrompt: 'Summarize the transcript.',
      params: {},
    });
    const response = await POST(request());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'transcript_processor_required' },
    });
    expect(mocks.handleTranscription).not.toHaveBeenCalled();
  });

  it('rejects a processor positively known to be a non-language model', async () => {
    mocks.verifyKey.mockResolvedValue({
      ...key,
      systemPrompt: 'Summarize the transcript.',
      params: { transcriptProcessorModel: 'openai/gpt-image-1' },
    });
    mocks.processorCapability.mockResolvedValue('not_language');
    const response = await POST(request());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'processor_model_not_language' },
    });
    expect(mocks.handleTranscription).not.toHaveBeenCalled();
  });

  it('uses one RPM slot, enforces budget, and passes key-owned config to the handler', async () => {
    const processedKey = {
      ...key,
      systemPrompt: 'List action items.',
      params: { transcriptProcessorModel: 'openai/gpt-5-mini' },
    };
    mocks.verifyKey.mockResolvedValue(processedKey);

    const response = await POST(
      request({ fields: { model: 'client/model-is-ignored', language: 'en' } }),
    );
    expect(response.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledOnce();
    expect(mocks.costUsedThisMonth).toHaveBeenCalledWith(key.id);
    expect(mocks.handleTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        model: key.model,
        systemPrompt: 'List action items.',
        params: { transcriptProcessorModel: 'openai/gpt-5-mini' },
        monthlyCostCapUsd: 100,
        monthlyCostUsedUsd: 0,
      }),
      expect.objectContaining({
        language: 'en',
        file: expect.objectContaining({ name: 'meeting.wav', format: 'wav' }),
      }),
    );
  });

  it('returns existing rate-limit and monthly-budget errors without calling upstream', async () => {
    const bodyRead = vi.fn(() => {
      throw new Error('request body should not be read');
    });
    const unreadableBody = () =>
      new ReadableStream<Uint8Array>(
        {
          pull: bodyRead,
        },
        { highWaterMark: 0 },
      );

    mocks.checkRateLimit.mockResolvedValue({ ok: false, reset: Date.now() + 3_000 });
    const limited = await POST(streamingRequest(unreadableBody()));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(bodyRead).not.toHaveBeenCalled();

    mocks.checkRateLimit.mockResolvedValue({ ok: true });
    mocks.costUsedThisMonth.mockResolvedValue(100);
    const overBudget = await POST(streamingRequest(unreadableBody()));
    expect(overBudget.status).toBe(402);
    await expect(overBudget.json()).resolves.toMatchObject({
      error: { code: 'quota_exceeded' },
    });
    expect(bodyRead).not.toHaveBeenCalled();
    expect(mocks.handleTranscription).not.toHaveBeenCalled();
  });
});
