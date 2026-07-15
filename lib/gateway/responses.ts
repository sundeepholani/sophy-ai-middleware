/**
 * Responses-API call handlers. Run the model through the AI Gateway (reusing the
 * chat path's commonCall + usage accounting) and serialize to the Responses wire
 * format — buffered object or the SSE event sequence.
 *
 * Streaming follows the exact OpenAI event order:
 *   response.created → response.in_progress → response.output_item.added →
 *   response.content_part.added → response.output_text.delta* →
 *   response.output_text.done → response.content_part.done →
 *   response.output_item.done → response.completed
 * with an incrementing `sequence_number` on every event and NO `[DONE]` sentinel.
 *
 * Drain-to-completion (consumeStream + waitUntil) mirrors the chat path so usage
 * is always accounted even if the client disconnects.
 */
import { randomBytes } from 'node:crypto';
import { generateText, streamText, Output, jsonSchema } from 'ai';
import type { ModelMessage } from 'ai';
import { waitUntil } from '@vercel/functions';
import { randomUUID } from 'node:crypto';
import { commonCall, type CallContext } from '@/lib/gateway/call';
import { generateStructured, StructuredAttemptError } from '@/lib/gateway/structured';
import { scheduleChampionCapture } from '@/lib/eval/capture';
import { validateAgainstSchema } from '@/lib/gateway/openai-map';
import {
  recordUsage,
  recordRequestLog,
  normalizeUsage,
  extractGatewayCost,
  extractGatewayRequestId,
  ZERO_USAGE,
} from '@/lib/usage/record';
import { openAiError } from '@/lib/http/openai';
import { safeGatewayErrorMessage, upstreamErrorResponse } from '@/lib/gateway/upstream-error';
import {
  normalizeProjectGatewayError,
  ProjectGatewayUnavailableError,
} from '@/lib/gateway/project-provider';
import {
  buildResponseObject,
  mapResponsesUsage,
  responsesSseEvent,
  type ResponsesOutToolCall,
} from '@/lib/http/responses';

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function respId(): string {
  return `resp_${randomBytes(18).toString('hex')}`;
}
function msgId(): string {
  return `msg_${randomBytes(18).toString('hex')}`;
}
function fcId(): string {
  return `fc_${randomBytes(18).toString('hex')}`;
}

/** Map the AI SDK's returned tool calls to the Responses output-item shape. */
function toResponsesToolCalls(
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>,
): ResponsesOutToolCall[] {
  return toolCalls.map((tc) => ({
    id: fcId(),
    callId: tc.toolCallId,
    name: tc.toolName,
    arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
  }));
}

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

// ---- Non-streaming ----------------------------------------------------------

export async function handleResponsesNonStreaming(
  ctx: CallContext,
  messages: ModelMessage[],
): Promise<Response> {
  const start = Date.now();
  const id = respId();
  const created = Math.floor(start / 1000);
  const provider = ctx.model.split('/')[0] ?? 'unknown';
  const eventId = randomUUID();
  const base = {
    id: eventId,
    projectId: ctx.gateway.projectId,
    gatewayCredentialId: ctx.gateway.gatewayCredentialId,
    keyId: ctx.keyId,
    provider,
    model: ctx.model,
  };
  const logIf = (response: string | null, status: 'ok' | 'validation_failed' | 'error') =>
    ctx.logContent
      ? recordRequestLog({
          id: eventId,
          projectId: ctx.gateway.projectId,
          keyId: ctx.keyId,
          surface: 'responses',
          systemPrompt: ctx.systemPrompt,
          messages,
          response,
          streamed: false,
          status,
        })
      : Promise.resolve();

  try {
    let text: string;
    if (ctx.structured && ctx.schema) {
      // Tolerant structured generation (see lib/gateway/structured.ts): native
      // models unchanged; fence/pad-wrapping models are recovered; only genuinely
      // unparseable output still 502s.
      const result = await generateStructured(commonCall(ctx, messages), ctx.schema);
      // usage/costUsd are aggregated across attempts — the tolerant retry path
      // bills two upstream calls and both must be charged.
      const usage = normalizeUsage(result.usage);
      const costUsd = result.costUsd;
      const gatewayRequestId = extractGatewayRequestId(result.providerMetadata);
      if (!result.valid) {
        await recordUsage({
          ...base,
          usage,
          costUsd,
          latencyMs: Date.now() - start,
          status: 'validation_failed',
          responseKind: 'structured',
          gatewayRequestId,
          errorMessage: result.errors,
        });
        await logIf(result.text, 'validation_failed');
        return openAiError(502, 'api_error', 'Model output failed schema validation.', {
          code: 'schema_validation_failed',
        });
      }
      text = result.text;
      await recordUsage({
        ...base,
        usage,
        costUsd,
        latencyMs: Date.now() - start,
        status: 'ok',
        responseKind: 'structured',
        gatewayRequestId,
      });
      await logIf(text, 'ok');
      // The capture must carry the same aggregated cost usage_events was charged.
      scheduleChampionCapture(ctx, messages, 'responses', text, costUsd, start, eventId);
      return Response.json(
        buildResponseObject({
          id,
          msgId: msgId(),
          model: ctx.model,
          createdAt: created,
          status: 'completed',
          text,
          usage: mapResponsesUsage(usage),
          structured: true,
          temperature: ctx.params.temperature,
          topP: ctx.params.topP,
        }),
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    const result = await generateText(commonCall(ctx, messages));
    const usage = normalizeUsage(result.usage);
    const costUsd = extractGatewayCost(result.providerMetadata);
    const toolCalls = ctx.tools ? toResponsesToolCalls(result.toolCalls) : undefined;
    await recordUsage({
      ...base,
      usage,
      costUsd,
      latencyMs: Date.now() - start,
      status: 'ok',
      responseKind: 'text',
      gatewayRequestId: extractGatewayRequestId(result.providerMetadata),
    });
    await logIf(result.text || (toolCalls?.length ? JSON.stringify(toolCalls) : ''), 'ok');
    // Tool-call turns aren't captured for eval (client owns the tool loop).
    if (!ctx.tools) {
      scheduleChampionCapture(ctx, messages, 'responses', result.text, costUsd, start, eventId);
    }
    return Response.json(
      buildResponseObject({
        id,
        msgId: msgId(),
        model: ctx.model,
        createdAt: created,
        status: 'completed',
        // No message item when the turn is purely tool calls.
        text: toolCalls?.length ? result.text || null : result.text,
        usage: mapResponsesUsage(usage),
        structured: false,
        temperature: ctx.params.temperature,
        topP: ctx.params.topP,
        toolCalls,
      }),
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    // A StructuredAttemptError means the strict attempt COMPLETED (billed)
    // before the retry failed — charge its carried usage/cost, not zero.
    const carried = err instanceof StructuredAttemptError ? err : null;
    const normalizedError = await normalizeProjectGatewayError(ctx.gateway, err);
    await recordUsage({
      ...base,
      usage: carried ? normalizeUsage(carried.usage) : { ...ZERO_USAGE },
      costUsd: carried?.costUsd,
      latencyMs: Date.now() - start,
      status: 'error',
      responseKind: ctx.structured ? 'structured' : 'text',
      errorMessage: safeGatewayErrorMessage(normalizedError),
    });
    await logIf(null, 'error');
    return upstreamErrorResponse(normalizedError, 'Upstream model request failed.');
  }
}

// ---- Streaming --------------------------------------------------------------

export function handleResponsesStreaming(ctx: CallContext, messages: ModelMessage[]): Response {
  const start = Date.now();
  const id = respId();
  const mid = msgId();
  const created = Math.floor(start / 1000);
  const model = ctx.model;
  const provider = model.split('/')[0] ?? 'unknown';
  const eventId = randomUUID();
  const base = {
    id: eventId,
    projectId: ctx.gateway.projectId,
    gatewayCredentialId: ctx.gateway.gatewayCredentialId,
    keyId: ctx.keyId,
    provider,
    model,
    streamed: true,
    responseKind: (ctx.structured ? 'structured' : 'text') as 'structured' | 'text',
  };
  const logIf = (response: string | null, status: 'ok' | 'validation_failed' | 'error') =>
    ctx.logContent
      ? recordRequestLog({
          id: eventId,
          projectId: ctx.gateway.projectId,
          keyId: ctx.keyId,
          surface: 'responses',
          systemPrompt: ctx.systemPrompt,
          messages,
          response,
          streamed: true,
          status,
        })
      : Promise.resolve();

  const result = streamText({
    ...commonCall(ctx, messages),
    ...(ctx.structured && ctx.schema
      ? { experimental_output: Output.object({ schema: jsonSchema(ctx.schema) }) }
      : {}),
    onFinish: async (event) => {
      const eo = (event as { experimental_output?: unknown }).experimental_output;
      // Match the buffered path: validate structured output against the key's schema
      // and record validation_failed (not a blanket 'ok') on mismatch. The streamed
      // bytes can't be retracted, but accounting stays consistent and a non-conforming
      // structured turn isn't captured as a replayable champion sample.
      let status: 'ok' | 'validation_failed' = 'ok';
      if (ctx.structured && ctx.schema) {
        const obj = eo !== undefined ? eo : safeParseJson(event.text);
        if (!validateAgainstSchema(obj, ctx.schema).valid) status = 'validation_failed';
      }
      const costUsd = extractGatewayCost(event.providerMetadata);
      await recordUsage({
        ...base,
        usage: normalizeUsage(event.totalUsage ?? event.usage),
        costUsd,
        latencyMs: Date.now() - start,
        status,
        gatewayRequestId: extractGatewayRequestId(event.providerMetadata),
      });
      const toolCallsOut = event.toolCalls?.length ? JSON.stringify(event.toolCalls) : '';
      await logIf(event.text || toolCallsOut, status);
      const championOut = ctx.structured && eo !== undefined ? JSON.stringify(eo) : event.text;
      if (!ctx.tools && status === 'ok') {
        scheduleChampionCapture(ctx, messages, 'responses', championOut, costUsd, start, eventId);
      }
    },
    onError: async ({ error }) => {
      const normalizedError = await normalizeProjectGatewayError(ctx.gateway, error);
      await recordUsage({
        ...base,
        usage: { ...ZERO_USAGE },
        latencyMs: Date.now() - start,
        status: 'error',
        errorMessage: safeGatewayErrorMessage(normalizedError),
      });
      await logIf(null, 'error');
    },
  });

  // Drain regardless of client connection so onFinish (accounting) always fires.
  waitUntil(Promise.resolve(result.consumeStream()));

  const encoder = new TextEncoder();
  const resp = (
    status: 'in_progress' | 'completed',
    text: string | null,
    usage: ReturnType<typeof mapResponsesUsage> | null,
    toolCalls?: ResponsesOutToolCall[],
    output?: Record<string, unknown>[],
  ) =>
    buildResponseObject({
      id,
      msgId: mid,
      model,
      createdAt: created,
      status,
      text,
      usage,
      structured: ctx.structured,
      temperature: ctx.params.temperature,
      topP: ctx.params.topP,
      toolCalls,
      output,
    });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0;
      const emit = (type: string, data: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(responsesSseEvent(type, { sequence_number: seq++, ...data })));
      let acc = '';
      // Output items are added on demand: the text message item only when text
      // arrives (so a pure tool-call turn emits no empty message), and each tool
      // call as its own function_call item at the next output index.
      let textIndex = -1;
      let nextIndex = 0;
      const toolCalls: ResponsesOutToolCall[] = [];
      // Items in the exact order they were streamed (with their output_index), so
      // response.completed's output[] matches the streamed indices even if a tool
      // call precedes text.
      const emitted: { index: number; item: Record<string, unknown> }[] = [];
      const openText = () => {
        if (textIndex >= 0) return;
        textIndex = nextIndex++;
        emit('response.output_item.added', {
          output_index: textIndex,
          item: { id: mid, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        });
        emit('response.content_part.added', {
          item_id: mid,
          output_index: textIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
        });
      };
      try {
        emit('response.created', { response: resp('in_progress', null, null) });
        emit('response.in_progress', { response: resp('in_progress', null, null) });
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            const t = (part as { text?: string }).text ?? '';
            if (t) {
              openText();
              acc += t;
              emit('response.output_text.delta', {
                item_id: mid,
                output_index: textIndex,
                content_index: 0,
                delta: t,
                logprobs: [],
              });
            }
          } else if (part.type === 'tool-call') {
            const tc = part as unknown as { toolCallId: string; toolName: string; input: unknown };
            const itemId = fcId();
            const argsStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {});
            const oi = nextIndex++;
            toolCalls.push({ id: itemId, callId: tc.toolCallId, name: tc.toolName, arguments: argsStr });
            const fc = (status: string) => ({
              id: itemId,
              type: 'function_call',
              status,
              call_id: tc.toolCallId,
              name: tc.toolName,
              arguments: status === 'in_progress' ? '' : argsStr,
            });
            emit('response.output_item.added', { output_index: oi, item: fc('in_progress') });
            emit('response.function_call_arguments.delta', { item_id: itemId, output_index: oi, delta: argsStr });
            emit('response.function_call_arguments.done', { item_id: itemId, output_index: oi, arguments: argsStr });
            emit('response.output_item.done', { output_index: oi, item: fc('completed') });
            emitted.push({ index: oi, item: fc('completed') });
          } else if (part.type === 'error') {
            throw (part as { error: unknown }).error;
          }
        }
        if (textIndex >= 0) {
          emit('response.output_text.done', { item_id: mid, output_index: textIndex, content_index: 0, text: acc, logprobs: [] });
          emit('response.content_part.done', {
            item_id: mid,
            output_index: textIndex,
            content_index: 0,
            part: { type: 'output_text', text: acc, annotations: [], logprobs: [] },
          });
          const messageItem = {
            id: mid,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: acc, annotations: [] }],
          };
          emit('response.output_item.done', { output_index: textIndex, item: messageItem });
          emitted.push({ index: textIndex, item: messageItem });
        }
        let usage = { ...ZERO_USAGE };
        try {
          usage = normalizeUsage(await result.totalUsage);
        } catch {
          /* keep zero */
        }
        // Build completed output[] in streamed-index order so it matches the
        // output_index the client saw on each streamed item.
        const orderedOutput = emitted.sort((a, b) => a.index - b.index).map((e) => e.item);
        emit('response.completed', {
          response: resp('completed', acc || null, mapResponsesUsage(usage), undefined, orderedOutput),
        });
        controller.close();
      } catch (error) {
        // HTTP status is already committed, so surface a typed Responses event.
        // Accounting is handled by onFinish/onError via consumeStream().
        const normalizedError = await normalizeProjectGatewayError(ctx.gateway, error);
        try {
          const projectUnavailable = ProjectGatewayUnavailableError.isInstance(normalizedError);
          emit('response.failed', {
            response: {
              ...resp('in_progress', acc || null, null),
              status: 'failed',
              error: {
                code: projectUnavailable ? normalizedError.code : 'upstream_error',
                message: projectUnavailable
                  ? 'This project is not ready to make AI requests. Ask a project admin to check its Vercel AI Gateway key.'
                  : 'Upstream model request failed.',
              },
            },
          });
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
