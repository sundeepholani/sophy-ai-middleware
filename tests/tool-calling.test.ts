import { describe, it, expect } from 'vitest';
import { toAiToolSet, toModelMessages, toChatCompletion } from '@/lib/gateway/openai-map';
import type { OpenAIMessage, OpenAITool } from '@/lib/http/openai';
import { ZERO_USAGE } from '@/lib/usage/record';

const weatherTool: OpenAITool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

describe('toAiToolSet', () => {
  it('returns null when there are no tools', () => {
    expect(toAiToolSet(undefined, undefined)).toBeNull();
    expect(toAiToolSet([], 'auto')).toBeNull();
  });

  it('builds a ToolSet keyed by function name, with no execute (passthrough)', () => {
    const r = toAiToolSet([weatherTool], 'auto');
    expect(r).not.toBeNull();
    expect(Object.keys(r!.tools)).toEqual(['get_weather']);
    // passthrough = the tool carries no execute fn
    expect((r!.tools.get_weather as { execute?: unknown }).execute).toBeUndefined();
    expect(r!.toolChoice).toBe('auto');
  });

  it('maps tool_choice variants', () => {
    expect(toAiToolSet([weatherTool], 'required')!.toolChoice).toBe('required');
    expect(toAiToolSet([weatherTool], 'none')!.toolChoice).toBe('none');
    expect(
      toAiToolSet([weatherTool], { type: 'function', function: { name: 'get_weather' } })!.toolChoice,
    ).toEqual({ type: 'tool', toolName: 'get_weather' });
    expect(toAiToolSet([weatherTool], undefined)!.toolChoice).toBeUndefined();
  });

  it('skips malformed tool entries', () => {
    const bad = [{ type: 'function', function: {} }] as unknown as OpenAITool[];
    expect(toAiToolSet(bad, 'auto')).toBeNull();
  });
});

describe('toModelMessages (tool turns)', () => {
  it('round-trips an assistant tool_calls + tool result conversation', () => {
    const msgs: OpenAIMessage[] = [
      { role: 'user', content: 'weather in Paris?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '18C and sunny' },
    ];
    const out = toModelMessages(msgs);
    expect(out).toHaveLength(3);
    // user
    expect(out[0]).toMatchObject({ role: 'user', content: 'weather in Paris?' });
    // assistant with a tool-call part
    expect(out[1].role).toBe('assistant');
    const aContent = out[1].content as Array<Record<string, unknown>>;
    expect(aContent[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'call_1',
      toolName: 'get_weather',
      input: { city: 'Paris' },
    });
    // tool result, with the tool name recovered from the assistant call
    expect(out[2].role).toBe('tool');
    const tContent = out[2].content as Array<Record<string, unknown>>;
    expect(tContent[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'call_1',
      toolName: 'get_weather',
      output: { type: 'text', value: '18C and sunny' },
    });
  });

  it('drops a tool message with no tool_call_id', () => {
    const out = toModelMessages([{ role: 'tool', content: 'orphan' }]);
    expect(out).toHaveLength(0);
  });
});

describe('toChatCompletion (tool calls)', () => {
  it('emits tool_calls with null content and finish_reason tool_calls', () => {
    const c = toChatCompletion({
      id: 'chatcmpl-x',
      created: 1,
      model: 'anthropic/claude-sonnet-4.6',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
      finishReason: 'tool-calls',
      usage: ZERO_USAGE,
    });
    const choice = c.choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
  });

  it('leaves a normal text completion unchanged (no tool_calls key)', () => {
    const c = toChatCompletion({
      id: 'chatcmpl-y',
      created: 1,
      model: 'm',
      content: 'hello',
      finishReason: 'stop',
      usage: ZERO_USAGE,
    });
    expect(c.choices[0].message.content).toBe('hello');
    expect(c.choices[0].message.tool_calls).toBeUndefined();
    expect(c.choices[0].finish_reason).toBe('stop');
  });
});
