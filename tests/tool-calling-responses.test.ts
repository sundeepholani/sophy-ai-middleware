import { describe, it, expect } from 'vitest';
import { responsesToAiToolSet } from '@/lib/gateway/openai-map';
import {
  responsesInputToMessages,
  buildResponseObject,
  type ResponsesInputItem,
  type ResponsesOutToolCall,
} from '@/lib/http/responses';

const weather = {
  type: 'function',
  name: 'get_weather',
  description: 'Get the weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

describe('responsesToAiToolSet', () => {
  it('builds a passthrough ToolSet from flat function tools', () => {
    const r = responsesToAiToolSet([weather], 'auto');
    expect(r).not.toBeNull();
    expect(Object.keys(r!.tools)).toEqual(['get_weather']);
    expect((r!.tools.get_weather as { execute?: unknown }).execute).toBeUndefined();
    expect(r!.toolChoice).toBe('auto');
  });

  it('maps the flat tool_choice variant and null cases', () => {
    expect(responsesToAiToolSet(undefined, undefined)).toBeNull();
    expect(responsesToAiToolSet([], 'auto')).toBeNull();
    expect(responsesToAiToolSet([weather], { type: 'function', name: 'get_weather' })!.toolChoice).toEqual({
      type: 'tool',
      toolName: 'get_weather',
    });
    // non-function (built-in) tools are not passed through
    expect(responsesToAiToolSet([{ type: 'web_search' }], 'auto')).toBeNull();
  });
});

describe('responsesInputToMessages (tool turns)', () => {
  it('maps function_call + function_call_output items, grouped as assistant then tool', () => {
    const input: ResponsesInputItem[] = [
      { role: 'user', content: 'weather in Paris?' },
      { type: 'function_call', call_id: 'fc_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'fc_1', output: '18C and sunny' },
    ];
    const out = responsesInputToMessages(input);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ role: 'user', content: 'weather in Paris?' });
    expect(out[1].role).toBe('assistant');
    expect((out[1].content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'fc_1',
      toolName: 'get_weather',
      input: { city: 'Paris' },
    });
    expect(out[2].role).toBe('tool');
    expect((out[2].content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'fc_1',
      toolName: 'get_weather',
      output: { type: 'text', value: '18C and sunny' },
    });
  });

  it('groups multiple parallel tool calls into one assistant + one tool message', () => {
    const input: ResponsesInputItem[] = [
      { type: 'function_call', call_id: 'a', name: 'f', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'g', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'ra' },
      { type: 'function_call_output', call_id: 'b', output: 'rb' },
    ];
    const out = responsesInputToMessages(input);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('assistant');
    expect((out[0].content as unknown[]).length).toBe(2);
    expect(out[1].role).toBe('tool');
    expect((out[1].content as unknown[]).length).toBe(2);
  });
});

describe('buildResponseObject (function_call output items)', () => {
  it('emits a function_call item and no message item for a pure tool-call turn', () => {
    const tc: ResponsesOutToolCall = { id: 'fc_x', callId: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' };
    const obj = buildResponseObject({
      id: 'resp_1',
      msgId: 'msg_1',
      model: 'm',
      createdAt: 1,
      status: 'completed',
      text: null,
      usage: null,
      structured: false,
      toolCalls: [tc],
    });
    const output = obj.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      type: 'function_call',
      id: 'fc_x',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
      status: 'completed',
    });
  });
});
