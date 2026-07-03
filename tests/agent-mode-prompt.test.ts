import { describe, it, expect } from 'vitest';
import { collectClientSystemText, composeSystemPrompt } from '@/lib/gateway/openai-map';
import { collectResponsesClientSystemText } from '@/lib/http/responses';
import type { OpenAIMessage } from '@/lib/http/openai';

describe('collectClientSystemText (chat surface)', () => {
  it('collects system and developer messages in order, joined by blank lines', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'You are TriageBot.' },
      { role: 'user', content: 'hello' },
      { role: 'developer', content: 'Always call tools.' },
    ];
    expect(collectClientSystemText(messages)).toBe('You are TriageBot.\n\nAlways call tools.');
  });

  it('reads text parts and ignores whitespace-only content', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: ' two' }] },
      { role: 'system', content: '   ' },
    ];
    expect(collectClientSystemText(messages)).toBe('part one two');
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

describe('collectResponsesClientSystemText (responses surface)', () => {
  it('instructions come first, then system/developer input items', () => {
    const got = collectResponsesClientSystemText({
      instructions: 'You are TriageBot.',
      input: [
        { role: 'system', content: 'House rules.' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(got).toBe('You are TriageBot.\n\nHouse rules.');
  });

  it('handles string input + missing instructions', () => {
    expect(collectResponsesClientSystemText({ input: 'plain string input' })).toBeNull();
    expect(collectResponsesClientSystemText({ instructions: '  ' })).toBeNull();
    expect(collectResponsesClientSystemText({ instructions: 'X' })).toBe('X');
  });

  it('skips function_call items without reading their role', () => {
    const got = collectResponsesClientSystemText({
      input: [
        { type: 'function_call', call_id: 'c1', name: 't', arguments: '{}' } as never,
        { role: 'developer', content: [{ type: 'input_text', text: 'dev note' }] } as never,
      ],
    });
    expect(got).toBe('dev note');
  });
});
