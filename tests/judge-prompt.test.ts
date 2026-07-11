import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { buildJudgePrompt, JudgeError } from '@/lib/eval/judge';

const msg = (role: string, content: unknown) => ({ role, content }) as unknown as ModelMessage;

describe('buildJudgePrompt', () => {
  it('renders a plain text conversation and both responses', () => {
    const p = buildJudgePrompt({
      systemPrompt: 'Be terse.',
      messages: [msg('user', 'What is 2+2?')],
      responseA: '4',
      responseB: 'Four.',
    });
    expect(p).toContain('## Operator system instruction\nBe terse.');
    expect(p).toContain('USER: What is 2+2?');
    expect(p).toContain('## Response A\n4');
    expect(p).toContain('## Response B\nFour.');
  });

  it('replaces image parts with a placeholder instead of inlining base64', () => {
    const base64 = 'A'.repeat(500_000); // stands in for a ~500KB data URL
    const p = buildJudgePrompt({
      systemPrompt: null,
      messages: [
        msg('user', [
          { type: 'text', text: 'What is in this picture?' },
          { type: 'image', image: `data:image/png;base64,${base64}` },
        ]),
      ],
      responseA: 'A cat.',
      responseB: 'A dog.',
    });
    expect(p).toContain('What is in this picture?');
    expect(p).toContain('[image part omitted]');
    expect(p).not.toContain(base64.slice(0, 100));
    // The whole point: the prompt stays judge-sized, not media-sized.
    expect(p.length).toBeLessThan(10_000);
  });

  it('labels unknown non-text parts generically', () => {
    const p = buildJudgePrompt({
      systemPrompt: null,
      messages: [msg('user', [{ mimeType: 'application/pdf', data: 'x'.repeat(1000) }])],
      responseA: 'a',
      responseB: 'b',
    });
    expect(p).toContain('[non-text part omitted]');
    expect(p).not.toContain('x'.repeat(100));
  });

  it('caps an oversized conversation tail-keep, preserving the final user turn', () => {
    const p = buildJudgePrompt({
      systemPrompt: null,
      messages: [
        msg('user', 'y'.repeat(200_000)),
        msg('assistant', 'noted'),
        msg('user', 'FINAL-QUESTION: what is the answer?'),
      ],
      responseA: 'a',
      responseB: 'b',
    });
    expect(p).toContain('…[earlier conversation truncated]');
    // The judge must always see the request both responses answer.
    expect(p).toContain('FINAL-QUESTION: what is the answer?');
    expect(p.length).toBeLessThan(70_000);
    // Responses must survive the conversation cap untouched.
    expect(p).toContain('## Response A\na');
    expect(p).toContain('## Response B\nb');
  });

  it('caps an oversized operator system prompt', () => {
    const p = buildJudgePrompt({
      systemPrompt: 's'.repeat(100_000),
      messages: [msg('user', 'q')],
      responseA: 'a',
      responseB: 'b',
    });
    expect(p).toContain('…[truncated for judging]');
    expect(p.length).toBeLessThan(30_000);
  });

  it('caps each oversized response independently', () => {
    const p = buildJudgePrompt({
      systemPrompt: null,
      messages: [msg('user', 'q')],
      responseA: 'a'.repeat(100_000),
      responseB: 'b'.repeat(100_000),
    });
    const markers = p.match(/…\[truncated for judging\]/g) ?? [];
    expect(markers.length).toBe(2);
    expect(p.length).toBeLessThan(90_000);
  });

  it('never exceeds the combined section caps regardless of input size', () => {
    const p = buildJudgePrompt({
      systemPrompt: 's'.repeat(100_000),
      messages: Array.from({ length: 50 }, (_, i) => msg('user', `${i}: ` + 'z'.repeat(10_000))),
      responseA: 'a'.repeat(500_000),
      responseB: 'b'.repeat(500_000),
    });
    // 20K (system) + 60K (conversation) + 2×40K (responses) + scaffolding, with slack.
    expect(p.length).toBeLessThan(170_000);
  });
});

describe('JudgeError', () => {
  it('carries the billed cost of the failed judge attempt', () => {
    const e = new JudgeError('bad verdict', 0.123);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('JudgeError');
    expect(e.costUsd).toBe(0.123);
  });

  it('accepts a null cost when the gateway reported none', () => {
    expect(new JudgeError('bad', null).costUsd).toBeNull();
  });
});
