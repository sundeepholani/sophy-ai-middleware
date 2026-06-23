import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { withPromptCache } from '@/lib/gateway/call';

const EPHEMERAL = { type: 'ephemeral' };
function lastAnthropic(msgs: ModelMessage[]) {
  const last = msgs[msgs.length - 1] as { providerOptions?: { anthropic?: { cacheControl?: unknown } } };
  return last.providerOptions?.anthropic?.cacheControl;
}

describe('withPromptCache', () => {
  const convo: ModelMessage[] = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ];

  it('marks the last message for anthropic multi-turn requests', () => {
    const out = withPromptCache('anthropic/claude-sonnet-4.6', convo);
    expect(lastAnthropic(out)).toEqual(EPHEMERAL);
    // earlier messages are untouched
    expect((out[0] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  it('does not mutate the input array or its messages', () => {
    const input: ModelMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    withPromptCache('anthropic/claude-sonnet-4.6', input);
    expect((input[1] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  it('skips single-turn requests (no re-read within TTL)', () => {
    const single: ModelMessage[] = [{ role: 'user', content: 'only' }];
    expect(withPromptCache('anthropic/claude-haiku-4.5', single)).toBe(single);
  });

  it('skips non-anthropic providers (they cache automatically)', () => {
    expect(withPromptCache('openai/gpt-5.5', convo)).toBe(convo);
    expect(withPromptCache('google/gemini-3-flash', convo)).toBe(convo);
  });

  it('preserves existing providerOptions on the last message', () => {
    const withOpts: ModelMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b', providerOptions: { anthropic: { foo: 'bar' } } } as ModelMessage,
    ];
    const out = withPromptCache('anthropic/claude-sonnet-4.6', withOpts);
    const last = out[out.length - 1] as { providerOptions?: { anthropic?: Record<string, unknown> } };
    expect(last.providerOptions?.anthropic?.foo).toBe('bar');
    expect(last.providerOptions?.anthropic?.cacheControl).toEqual(EPHEMERAL);
  });
});
