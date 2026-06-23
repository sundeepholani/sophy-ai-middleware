import { describe, it, expect } from 'vitest';
import { continuesConversation } from '@/lib/eval/capture';

const u = (content: string) => ({ role: 'user', content });
const a = (content: string) => ({ role: 'assistant', content });

describe('continuesConversation', () => {
  const turn1 = [u('Create a JD')];
  const out1 = 'What is the role title?';
  const turn2 = [u('Create a JD'), a('What is the role title?'), u('Sales Exec')];

  it('matches the next turn of the same conversation', () => {
    expect(continuesConversation(turn1, out1, turn2)).toBe(true);
  });

  it('matches deeper continuations too (turn 2 → turn 3)', () => {
    const out2 = 'How many years of experience?';
    const turn3 = [...turn2, a('How many years of experience?'), u('3 years')];
    expect(continuesConversation(turn2, out2, turn3)).toBe(true);
  });

  it('rejects a same-prefix conversation with a different assistant turn', () => {
    // Same opening prompt, but the captured sample produced a different question —
    // so this newReq belongs to a different conversation.
    expect(continuesConversation(turn1, 'A totally different question', turn2)).toBe(false);
  });

  it('rejects when newReq is not longer', () => {
    expect(continuesConversation(turn2, 'x', turn1)).toBe(false);
    expect(continuesConversation(turn1, out1, turn1)).toBe(false);
  });

  it('rejects when the prefix text diverges', () => {
    const other = [u('Write a poem'), a('What is the role title?'), u('Sales Exec')];
    expect(continuesConversation(turn1, out1, other)).toBe(false);
  });

  it('rejects when the message after the prefix is not the assistant turn', () => {
    const noAssistant = [u('Create a JD'), u('Sales Exec')];
    expect(continuesConversation(turn1, out1, noAssistant)).toBe(false);
  });

  it('tolerates a truncated champion output (matches on the prefix)', () => {
    const longText = 'X'.repeat(50);
    const capped = `${longText}…[truncated]`;
    const next = [u('Create a JD'), a(longText), u('more')];
    expect(continuesConversation(turn1, capped, next)).toBe(true);
  });

  it('matches when the client strips a ```json fence the model emitted', () => {
    const fenced = '```json\n{"question": "What is the role title?"}\n```';
    const stripped = '{"question": "What is the role title?"}';
    const next = [u('Create a JD'), a(stripped), u('Sales Exec')];
    expect(continuesConversation(turn1, fenced, next)).toBe(true);
  });

  it('does NOT treat a short common output as a prefix match (false-positive guard)', () => {
    // champion said "OK"; an unrelated convo's assistant reply merely starts with "OK".
    const next = [u('Create a JD'), a('OK, here is the full plan…'), u('go')];
    expect(continuesConversation(turn1, 'OK', next)).toBe(false);
  });

  it('matches JSON outputs across compact vs pretty formatting', () => {
    const compact = '{"a":1,"b":2}';
    const pretty = '{\n  "b": 2,\n  "a": 1\n}';
    const next = [u('Create a JD'), a(pretty), u('go')];
    expect(continuesConversation(turn1, compact, next)).toBe(true);
  });

  it('does not collapse same-text messages that carry different media', () => {
    const prev = [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image', image: 'CAT' }] }];
    const next = [
      { role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image', image: 'DOG' }] },
      a('an animal'),
      u('more'),
    ];
    expect(continuesConversation(prev, 'an animal', next)).toBe(false);
  });

  it('extracts text from array (parts) content', () => {
    const next = [u('Create a JD'), { role: 'assistant', content: [{ type: 'text', text: out1 }] }, u('Sales Exec')];
    expect(continuesConversation(turn1, out1, next)).toBe(true);
  });

  it('handles empty / malformed inputs safely', () => {
    expect(continuesConversation([], out1, turn2)).toBe(false);
    expect(continuesConversation(turn1, out1, [])).toBe(false);
    // @ts-expect-error exercising the non-array guard
    expect(continuesConversation(null, out1, turn2)).toBe(false);
  });
});
