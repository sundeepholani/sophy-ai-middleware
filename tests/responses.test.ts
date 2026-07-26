import { describe, it, expect } from 'vitest';
import {
  responsesInputToMessages,
  responsesReferencedUrls,
  mapResponsesUsage,
  buildResponseObject,
  responsesSseEvent,
} from '@/lib/http/responses';

describe('responsesInputToMessages', () => {
  it('wraps a string input as a single user message', () => {
    expect(responsesInputToMessages('hi')).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops system/developer items, keeps user (as parts) + assistant (text)', () => {
    const out = responsesInputToMessages([
      { role: 'system', content: 'client system (ignored)' },
      { role: 'developer', content: 'dev (ignored)' },
      { role: 'user', content: [{ type: 'input_text', text: 'part1 ' }, { type: 'input_text', text: 'part2' }] },
      { role: 'assistant', content: 'prior answer' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'part1 ' }, { type: 'text', text: 'part2' }] },
      { role: 'assistant', content: 'prior answer' },
    ]);
  });

  it('preserves an input_image as an AI SDK image part (the gap this closes)', () => {
    const out = responsesInputToMessages([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: 'https://example.com/cat.png' },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'what is this?' });
    expect(content[1].type).toBe('image');
    expect(String(content[1].image)).toBe('https://example.com/cat.png');
  });

  it('keeps an image-only user turn (previously dropped entirely)', () => {
    const out = responsesInputToMessages([
      { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/x.jpg' }] },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0].content as Array<Record<string, unknown>>)[0].type).toBe('image');
  });

  it('maps an input_file part', () => {
    const out = responsesInputToMessages([
      {
        role: 'user',
        content: [{ type: 'input_file', file_url: 'https://example.com/doc.pdf', filename: 'doc.pdf' }],
      },
    ]);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('file');
    expect(content[0].filename).toBe('doc.pdf');
    expect(String(content[0].data)).toBe('https://example.com/doc.pdf');
  });

  it('returns empty for null/empty input', () => {
    expect(responsesInputToMessages(undefined)).toEqual([]);
    expect(responsesInputToMessages('')).toEqual([]);
    expect(responsesInputToMessages([{ role: 'system', content: 'x' }])).toEqual([]);
  });
});

describe('responsesReferencedUrls', () => {
  it('extracts image and file URLs from input parts', () => {
    const urls = responsesReferencedUrls([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'x' },
          { type: 'input_image', image_url: 'https://example.com/a.png' },
          { type: 'input_file', file_url: 'https://example.com/b.pdf' },
        ],
      },
    ]);
    expect(urls).toEqual(['https://example.com/a.png', 'https://example.com/b.pdf']);
  });

  it('returns [] for string input', () => {
    expect(responsesReferencedUrls('hi')).toEqual([]);
  });

  // Regression: the ownership check must see every URL the model mapper forwards.
  // The mapper resolves `file_url ?? file_data`, so a blob URL smuggled through
  // file_data must still be collected — otherwise it bypasses assertOwnedBlobs.
  it('also extracts input_file URLs carried in file_data (matches the mapper sink)', () => {
    const urls = responsesReferencedUrls([
      {
        role: 'user',
        content: [{ type: 'input_file', file_data: 'https://x.blob.vercel-storage.com/uploads/other/secret.pdf' }],
      },
    ]);
    expect(urls).toEqual(['https://x.blob.vercel-storage.com/uploads/other/secret.pdf']);
  });
});

describe('mapResponsesUsage', () => {
  it('uses Responses field names (input_tokens/output_tokens/total_tokens)', () => {
    const u = mapResponsesUsage({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedInputTokens: 2,
      cacheWriteTokens: null,
      reasoningTokens: 1,
    });
    expect(u).toEqual({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 14,
    });
  });
});

describe('buildResponseObject', () => {
  const usage = mapResponsesUsage({
    inputTokens: 5,
    outputTokens: 3,
    totalTokens: 8,
    cachedInputTokens: 0,
    cacheWriteTokens: null,
    reasoningTokens: 0,
  });

  it('emits a spec-shaped completed response with an output_text part', () => {
    const r = buildResponseObject({
      id: 'resp_1',
      msgId: 'msg_1',
      model: 'anthropic/claude-haiku-4.5',
      createdAt: 1750000000,
      status: 'completed',
      text: 'Hello',
      usage,
      structured: false,
    }) as Record<string, unknown>;
    expect(r.object).toBe('response');
    expect(r.created_at).toBe(1750000000);
    expect(r.status).toBe('completed');
    // output[] message item with an output_text content part
    const output = r.output as Array<Record<string, unknown>>;
    expect(output[0].type).toBe('message');
    expect(output[0].role).toBe('assistant');
    const content = output[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'output_text', text: 'Hello', annotations: [] });
    // output_text must NOT be a top-level wire field
    expect('output_text' in r).toBe(false);
    // usage uses Responses names
    expect((r.usage as Record<string, unknown>).input_tokens).toBe(5);
  });

  it('structured flag sets text.format json_schema, and null text yields empty output', () => {
    const r = buildResponseObject({
      id: 'resp_2',
      msgId: 'msg_2',
      model: 'm',
      createdAt: 1,
      status: 'in_progress',
      text: null,
      usage: null,
      structured: true,
    }) as Record<string, unknown>;
    expect((r.text as { format: { type: string } }).format.type).toBe('json_schema');
    expect(r.output).toEqual([]);
  });
});

describe('responsesSseEvent', () => {
  it('emits event + data lines with type embedded in the JSON, one line, blank-line terminated', () => {
    const frame = responsesSseEvent('response.output_text.delta', {
      sequence_number: 4,
      delta: 'Hi',
    });
    expect(frame).toBe(
      'event: response.output_text.delta\n' +
        'data: {"type":"response.output_text.delta","sequence_number":4,"delta":"Hi"}\n\n',
    );
    // no embedded newline inside the data JSON
    const dataLine = frame.split('\n')[1];
    expect(dataLine.startsWith('data: ')).toBe(true);
    expect(JSON.parse(dataLine.slice(6)).type).toBe('response.output_text.delta');
  });
});
