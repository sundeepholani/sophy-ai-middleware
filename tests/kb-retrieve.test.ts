import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { latestUserText } from '@/lib/kb/retrieve';

describe('latestUserText', () => {
  it('returns the last user message when content is a plain string', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: '  what is the refund policy?  ' },
    ];
    expect(latestUserText(msgs)).toBe('what is the refund policy?');
  });

  it('joins text parts and ignores non-text parts in array content', () => {
    const msgs: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'image', image: 'https://example.com/x.png' },
          { type: 'text', text: 'line two' },
        ],
      },
    ];
    expect(latestUserText(msgs)).toBe('line one\nline two');
  });

  it('uses the latest user message, not an earlier one', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'newest' },
    ];
    expect(latestUserText(msgs)).toBe('newest');
  });

  it('returns empty string when there is no user message', () => {
    const msgs: ModelMessage[] = [{ role: 'assistant', content: 'hello' }];
    expect(latestUserText(msgs)).toBe('');
    expect(latestUserText([])).toBe('');
  });
});
