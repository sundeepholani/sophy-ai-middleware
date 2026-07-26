import { describe, it, expect } from 'vitest';
import {
  toModelMessages,
  resolveParams,
  mapFinishReason,
  validateAgainstSchema,
  chunkFrame,
  usageChunkFrame,
  sse,
} from '@/lib/gateway/openai-map';
import type { OpenAIMessage } from '@/lib/http/openai';

describe('toModelMessages', () => {
  it('drops client system/developer/tool messages, keeps user + assistant', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'client tries to set system' },
      { role: 'developer', content: 'dev note' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'tool', content: 'tool output' },
    ];
    const out = toModelMessages(messages);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
    expect(out[1].role).toBe('assistant');
  });

  it('maps text content parts', () => {
    const out = toModelMessages([
      { role: 'user', content: [{ type: 'text', text: 'part one' }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });
});

describe('resolveParams', () => {
  it('passes through the key params', () => {
    const out = resolveParams({ temperature: 0.5, maxOutputTokens: 1000, topP: 0.9 });
    expect(out.temperature).toBe(0.5);
    expect(out.maxOutputTokens).toBe(1000);
    expect(out.topP).toBe(0.9);
  });

  it('handles empty params', () => {
    expect(resolveParams({})).toEqual({
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
    });
  });
});

describe('mapFinishReason', () => {
  it('maps AI SDK reasons to OpenAI reasons', () => {
    expect(mapFinishReason('stop')).toBe('stop');
    expect(mapFinishReason('length')).toBe('length');
    expect(mapFinishReason('content-filter')).toBe('content_filter');
    expect(mapFinishReason('tool-calls')).toBe('tool_calls');
    expect(mapFinishReason(undefined)).toBe('stop');
  });
});

describe('validateAgainstSchema', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'number' } },
    required: ['name', 'age'],
    additionalProperties: false,
  };

  it('passes valid objects', () => {
    expect(validateAgainstSchema({ name: 'a', age: 1 }, schema).valid).toBe(true);
  });

  it('fails missing required fields', () => {
    const r = validateAgainstSchema({ name: 'a' }, schema);
    expect(r.valid).toBe(false);
    expect(r.errors).toBeTruthy();
  });

  it('fails wrong types', () => {
    expect(validateAgainstSchema({ name: 'a', age: 'x' }, schema).valid).toBe(false);
  });
});

describe('SSE frames', () => {
  it('builds OpenAI chat.completion.chunk frames', () => {
    const frame = chunkFrame({
      id: 'chatcmpl-1',
      created: 123,
      model: 'support-bot',
      delta: { content: 'hi' },
    });
    expect(frame.object).toBe('chat.completion.chunk');
    expect(frame.choices[0].delta.content).toBe('hi');
    expect(frame.choices[0].finish_reason).toBeNull();
  });

  it('usage chunk has empty choices and a usage block', () => {
    const frame = usageChunkFrame({
      id: 'x',
      created: 1,
      model: 'm',
      usage: {
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
        cachedInputTokens: 0,
        cacheWriteTokens: null,
        reasoningTokens: 0,
      },
    });
    expect(frame.choices).toHaveLength(0);
    expect(frame.usage?.prompt_tokens).toBe(3);
    expect(frame.usage?.completion_tokens).toBe(5);
    expect(frame.usage?.total_tokens).toBe(8);
  });

  it('sse() emits a data line terminated by a blank line', () => {
    expect(sse({ a: 1 })).toBe('data: {"a":1}\n\n');
  });
});
