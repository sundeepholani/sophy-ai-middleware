import type { ModelMessage } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));

import {
  discardExpiredImageInputs,
  IMAGE_INPUT_RETENTION_DAYS,
  prepareRequestLog,
  recordRequestLog,
} from '@/lib/usage/record';
import { toModelMessages } from '@/lib/gateway/openai-map';
import { responsesInputToMessages } from '@/lib/http/responses';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const KEY_ID = '00000000-0000-4000-8000-000000000002';
const REQUEST_ID = '00000000-0000-4000-8000-000000000003';
const STARTED_AT = new Date('2026-08-03T00:00:00.000Z');

function imageMessages(source: string): ModelMessage[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read the image exactly.' },
        { type: 'image', image: new URL(source) },
      ],
    },
  ];
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('seven-day complete image-input retention', () => {
  it('keeps a large inline image byte-for-byte for seven days and redacts before capping', () => {
    const source = `data:image/png;base64,${'A'.repeat(120_000)}UNIQUE_END`;
    const prepared = prepareRequestLog(imageMessages(source), STARTED_AT);
    const exact = prepared.request as Array<{ content: Array<{ image?: unknown }> }>;
    const redacted = prepared.requestAfterImageExpiry as Array<{
      content: Array<{ image?: unknown }>;
    }>;

    expect(exact[0].content[1].image).toBe(source);
    expect(Array.isArray(redacted)).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('data:image');
    expect(JSON.stringify(redacted)).not.toContain('UNIQUE_END');
    expect(redacted[0].content[1].image).toEqual(
      expect.objectContaining({
        contentOmittedFromLongTermLog: true,
        sourceType: 'inline_data',
      }),
    );
    expect(prepared.imageInputsExpiresAt?.toISOString()).toBe('2026-08-10T00:00:00.000Z');
    expect(IMAGE_INPUT_RETENTION_DAYS).toBe(7);
  });

  it('removes signed external URLs from the 30-day copy and preserves order', () => {
    const source = 'https://images.example/invoice.png?signature=TOP_SECRET';
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', image: new URL(source) },
          { type: 'text', text: 'first page' },
          { type: 'image', image: new URL('data:image/jpeg;base64,BBBB') },
        ],
      },
    ];
    const prepared = prepareRequestLog(messages, STARTED_AT);
    const redacted = prepared.requestAfterImageExpiry as Array<{
      content: Array<{ type: string; text?: string; image?: unknown }>;
    }>;

    expect(JSON.stringify(prepared.request)).toContain('TOP_SECRET');
    expect(JSON.stringify(redacted)).not.toContain('TOP_SECRET');
    expect(redacted[0].content.map((part) => part.type)).toEqual(['image', 'text', 'image']);
    expect(redacted[0].content[1].text).toBe('first page');
  });

  it('retains the existing 100k preview behavior for large text-only requests', () => {
    const messages = [{ role: 'user', content: 'T'.repeat(120_000) }] as ModelMessage[];
    const prepared = prepareRequestLog(messages, STARTED_AT);

    expect(prepared.request).toEqual(
      expect.objectContaining({ truncated: true, preview: expect.any(String) }),
    );
    expect(prepared.requestAfterImageExpiry).toBeNull();
    expect(prepared.imageInputsExpiresAt).toBeNull();
  });

  it('applies the same retention boundary to Chat and Responses image inputs', () => {
    const source = 'data:image/png;base64,CHAT_RESPONSES_PARITY';
    const chat = toModelMessages([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: source } }],
      },
    ]);
    const responses = responsesInputToMessages([
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: source }],
      },
    ]);

    const chatPrepared = prepareRequestLog(chat, STARTED_AT);
    const responsesPrepared = prepareRequestLog(responses, STARTED_AT);
    expect(chatPrepared.request).toEqual(responsesPrepared.request);
    expect(chatPrepared.requestAfterImageExpiry).toEqual(
      responsesPrepared.requestAfterImageExpiry,
    );
    expect(JSON.stringify(chatPrepared.request)).toContain('CHAT_RESPONSES_PARITY');
    expect(JSON.stringify(chatPrepared.requestAfterImageExpiry)).not.toContain(
      'CHAT_RESPONSES_PARITY',
    );
  });

  it('persists both retention views using trusted project and key identities', async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn(() => ({ values }));
    mocks.getDb.mockReturnValue({ insert });
    const source = 'data:image/png;base64,AAAA';

    await recordRequestLog({
      id: REQUEST_ID,
      projectId: PROJECT_ID,
      keyId: KEY_ID,
      surface: 'chat',
      systemPrompt: 'system',
      messages: imageMessages(source),
      requestStartedAt: STARTED_AT,
      response: 'done',
      status: 'ok',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        apiKeyId: KEY_ID,
        request: expect.any(Array),
        requestAfterImageExpiry: expect.any(Array),
        imageInputsExpiresAt: new Date('2026-08-10T00:00:00.000Z'),
        createdAt: STARTED_AT,
      }),
    );
    const saved = values.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(saved).toBeDefined();
    if (!saved) throw new Error('request log values were not captured');
    expect(JSON.stringify(saved.request)).toContain(source);
    expect(JSON.stringify(saved.requestAfterImageExpiry)).not.toContain(source);
  });

  it('never copies a failed insert or its image parameter into application logs', async () => {
    const source = 'data:image/png;base64,PRIVATE_IMAGE_BYTES';
    const onConflictDoNothing = vi
      .fn()
      .mockRejectedValue(new Error(`query failed with parameters: ${source}`));
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    mocks.getDb.mockReturnValue({ insert: vi.fn(() => ({ values })) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await recordRequestLog({
      id: REQUEST_ID,
      projectId: PROJECT_ID,
      keyId: KEY_ID,
      surface: 'chat',
      systemPrompt: 'system',
      messages: imageMessages(source),
      requestStartedAt: STARTED_AT,
      response: null,
      status: 'error',
    });

    expect(error).toHaveBeenCalledWith('[request-log] failed to insert request_log');
    expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE_IMAGE_BYTES');
    error.mockRestore();
  });

  it('atomically swaps expired complete inputs for the redacted copy', async () => {
    const where = vi.fn().mockResolvedValue({ rowCount: 3 });
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    mocks.getDb.mockReturnValue({ update });

    await expect(discardExpiredImageInputs(STARTED_AT)).resolves.toBe(3);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        requestAfterImageExpiry: null,
        imageInputsExpiresAt: null,
      }),
    );
    expect(where).toHaveBeenCalledOnce();
  });
});
