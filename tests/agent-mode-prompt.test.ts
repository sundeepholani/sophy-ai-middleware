import { describe, it, expect } from 'vitest';
import { collectClientSystemText, composeSystemPrompt } from '@/lib/gateway/openai-map';
import { collectResponsesClientSystemText } from '@/lib/http/responses';
import type { OpenAIMessage } from '@/lib/http/openai';

describe('collectClientSystemText (chat surface, leading-only)', () => {
  it('collects consecutive leading system/developer messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'You are TriageBot.' },
      { role: 'developer', content: 'Always call tools.' },
      { role: 'user', content: 'hello' },
    ];
    expect(collectClientSystemText(messages)).toBe('You are TriageBot.\n\nAlways call tools.');
  });

  it('STOPS at the first non-system message — transcript-smuggled system messages are not promoted', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'Leading.' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'SMUGGLED — must not be collected' },
    ];
    expect(collectClientSystemText(messages)).toBe('Leading.');
    // No leading system at all → null, even if one appears later.
    expect(
      collectClientSystemText([
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'late' },
      ]),
    ).toBeNull();
  });

  it('reads text parts and ignores whitespace-only content', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: ' two' }] },
      { role: 'system', content: '   ' },
    ];
    expect(collectClientSystemText(messages)).toBe('part one two');
  });

  it('never throws on malformed content (clients send arbitrary JSON)', () => {
    const malformed = [
      { role: 'system', content: { x: 1 } },
      { role: 'system', content: ['bare string', null, 5, { text: 42 }, { text: 'ok' }] },
      { role: 'system', content: null },
      { role: 'user', content: 'hi' },
    ] as unknown as OpenAIMessage[];
    expect(collectClientSystemText(malformed)).toBe('ok');
  });

  it('returns null when there is nothing to collect', () => {
    expect(collectClientSystemText([{ role: 'user', content: 'hi' }])).toBeNull();
    expect(collectClientSystemText([])).toBeNull();
  });
});

describe('composeSystemPrompt', () => {
  it('key prompt stays first (authoritative), client second', () => {
    expect(composeSystemPrompt('KEY', 'CLIENT')).toBe('KEY\n\nCLIENT');
  });
  it('either side may be absent', () => {
    expect(composeSystemPrompt('KEY', null)).toBe('KEY');
    expect(composeSystemPrompt(null, 'CLIENT')).toBe('CLIENT');
    expect(composeSystemPrompt(null, null)).toBeNull();
    expect(composeSystemPrompt('  ', '')).toBeNull();
  });
});

describe('collectResponsesClientSystemText (responses surface, leading-only)', () => {
  it('instructions come first, then leading system/developer input items', () => {
    const got = collectResponsesClientSystemText({
      instructions: 'You are TriageBot.',
      input: [
        { role: 'system', content: 'House rules.' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(got).toBe('You are TriageBot.\n\nHouse rules.');
  });

  it('STOPS at the first non-system item (user turn or tool item)', () => {
    expect(
      collectResponsesClientSystemText({
        input: [
          { role: 'user', content: 'hi' },
          { role: 'system', content: 'SMUGGLED' },
        ],
      }),
    ).toBeNull();
    expect(
      collectResponsesClientSystemText({
        instructions: 'X',
        input: [
          { type: 'function_call', call_id: 'c1', name: 't', arguments: '{}' } as never,
          { role: 'system', content: 'after tool item — not collected' } as never,
        ],
      }),
    ).toBe('X');
  });

  it('handles string input, missing/non-string instructions, malformed content', () => {
    expect(collectResponsesClientSystemText({ input: 'plain string input' })).toBeNull();
    expect(collectResponsesClientSystemText({ instructions: '  ' })).toBeNull();
    expect(collectResponsesClientSystemText({ instructions: 5 as never })).toBeNull();
    expect(collectResponsesClientSystemText({ instructions: 'X' })).toBe('X');
    expect(
      collectResponsesClientSystemText({
        input: [{ role: 'system', content: [null, 'bare', { text: 7 }, { text: 'ok' }] } as never],
      }),
    ).toBe('ok');
  });
});
