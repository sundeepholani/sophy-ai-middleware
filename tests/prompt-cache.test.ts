import { describe, it, expect } from 'vitest';
import { generateText, type ModelMessage } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { buildSystem, cachedSystem, withPromptCache } from '@/lib/gateway/call';
import { withJsonInstruction } from '@/lib/gateway/structured';
import { withKbContext } from '@/lib/kb/retrieve';

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

describe('cachedSystem', () => {
  const MODEL = 'anthropic/claude-sonnet-4.6';
  const KB = '--- BEGIN CONTEXT ---\n[1] fact\n--- END CONTEXT ---';

  it('marks the whole system prompt on anthropic, one-shot calls included', () => {
    expect(cachedSystem(MODEL, 'Be brief.')).toEqual([
      {
        role: 'system',
        content: buildSystem('Be brief.'),
        providerOptions: { anthropic: { cacheControl: EPHEMERAL } },
      },
    ]);
  });

  it('sends KB context as an unmarked block after the breakpoint', () => {
    const out = cachedSystem(MODEL, withKbContext('Be brief.', KB), KB);
    expect(out).toEqual([
      {
        role: 'system',
        content: buildSystem('Be brief.'),
        providerOptions: { anthropic: { cacheControl: EPHEMERAL } },
      },
      { role: 'system', content: KB },
    ]);
  });

  it('keeps the cached block byte-identical whether or not retrieval matched', () => {
    const withKb = cachedSystem(MODEL, withKbContext('Be brief.', KB), KB) as { content: string }[];
    const withoutKb = cachedSystem(MODEL, withKbContext('Be brief.', '')) as { content: string }[];
    expect(withKb[0].content).toBe(withoutKb[0].content);
  });

  it('caches the bare preamble for a KB-only key with no operator prompt', () => {
    const out = cachedSystem(MODEL, withKbContext(null, KB), KB) as { content: string }[];
    expect(out[0].content).toBe(buildSystem('x')!.slice(0, -'\n\nx'.length));
    expect(out[1].content).toBe(KB);
  });

  it('falls back to one marked block if the KB suffix does not match', () => {
    const out = cachedSystem(MODEL, 'Be brief.', KB) as { content: string }[];
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe(buildSystem('Be brief.'));
  });

  it('returns undefined with no system prompt', () => {
    expect(cachedSystem(MODEL, null)).toBeUndefined();
  });

  it('leaves other providers on the unchanged single string', () => {
    expect(cachedSystem('openai/gpt-5.5', withKbContext('Be brief.', KB), KB)).toBe(
      buildSystem(withKbContext('Be brief.', KB)),
    );
  });

  it('puts the cache markers on the request the AI Gateway receives', async () => {
    let body: { prompt?: { role: string; providerOptions?: unknown }[] } | undefined;
    const gateway = createGateway({
      apiKey: 'test-key',
      fetch: (async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response('{"error":{"message":"stop","type":"invalid_request_error"}}', {
          status: 400,
        });
      }) as typeof fetch,
    });
    await generateText({
      model: gateway.languageModel(MODEL),
      system: cachedSystem(MODEL, 'Be brief.'),
      messages: withPromptCache(MODEL, [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ]),
      maxRetries: 0,
    }).catch(() => {});
    const marked = { anthropic: { cacheControl: EPHEMERAL } };
    expect(body?.prompt?.map((m) => [m.role, m.providerOptions])).toEqual([
      ['system', marked],
      ['user', undefined],
      ['assistant', undefined],
      ['user', marked],
    ]);
  });
});

describe('withJsonInstruction', () => {
  const schema = { type: 'object' };

  it('appends to a string system prompt', () => {
    const out = withJsonInstruction('Be brief.', schema) as string;
    expect(out.startsWith('Be brief.\n\nRespond with ONLY')).toBe(true);
  });

  it('keeps cached system blocks intact and appends the instruction after them', () => {
    const blocks = cachedSystem('anthropic/claude-sonnet-4.6', 'Be brief.')!;
    const out = withJsonInstruction(blocks, schema) as { role: string; content: string }[];
    expect(out.slice(0, -1)).toEqual(blocks);
    expect(out.at(-1)?.content).toMatch(/^Respond with ONLY/);
  });

  it('stands alone without a system prompt', () => {
    expect(withJsonInstruction(undefined, schema)).toMatch(/^Respond with ONLY/);
  });
});
