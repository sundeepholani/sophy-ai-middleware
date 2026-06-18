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
import {
  buildResponseObject,
  mapResponsesUsage,
  responsesSseEvent,
} from '@/lib/http/responses';

function respId(): string {
  return `resp_${randomBytes(18).toString('hex')}`;
}
function msgId(): string {
  return `msg_${randomBytes(18).toString('hex')}`;
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
  const base = { id: eventId, keyId: ctx.keyId, provider, model: ctx.model };
  const logIf = (response: string | null, status: 'ok' | 'validation_failed' | 'error') =>
    ctx.logContent
      ? recordRequestLog({
          id: eventId,
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
      const result = await generateText({
        ...commonCall(ctx, messages),
        experimental_output: Output.object({ schema: jsonSchema(ctx.schema) }),
      });
      const usage = normalizeUsage(result.usage);
      const obj = result.experimental_output as unknown;
      const check = validateAgainstSchema(obj, ctx.schema);
      if (!check.valid) {
        await recordUsage({
          ...base,
          usage,
          costUsd: extractGatewayCost(result.providerMetadata),
          latencyMs: Date.now() - start,
          status: 'validation_failed',
          responseKind: 'structured',
          gatewayRequestId: extractGatewayRequestId(result.providerMetadata),
          errorMessage: check.errors,
        });
        await logIf(JSON.stringify(obj), 'validation_failed');
        return openAiError(502, 'api_error', 'Model output failed schema validation.', {
          code: 'schema_validation_failed',
        });
      }
      text = JSON.stringify(obj);
      await recordUsage({
        ...base,
        usage,
        costUsd: extractGatewayCost(result.providerMetadata),
        latencyMs: Date.now() - start,
        status: 'ok',
        responseKind: 'structured',
        gatewayRequestId: extractGatewayRequestId(result.providerMetadata),
      });
      await logIf(text, 'ok');
      scheduleChampionCapture(ctx, messages, 'responses', text, result.providerMetadata, start, eventId);
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
    await recordUsage({
      ...base,
      usage,
      costUsd: extractGatewayCost(result.providerMetadata),
      latencyMs: Date.now() - start,
      status: 'ok',
      responseKind: 'text',
      gatewayRequestId: extractGatewayRequestId(result.providerMetadata),
    });
    await logIf(result.text, 'ok');
    scheduleChampionCapture(ctx, messages, 'responses', result.text, result.providerMetadata, start, eventId);
    return Response.json(
      buildResponseObject({
        id,
        msgId: msgId(),
        model: ctx.model,
        createdAt: created,
        status: 'completed',
        text: result.text,
        usage: mapResponsesUsage(usage),
        structured: false,
        temperature: ctx.params.temperature,
        topP: ctx.params.topP,
      }),
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    await recordUsage({
      ...base,
      usage: { ...ZERO_USAGE },
      latencyMs: Date.now() - start,
      status: 'error',
      responseKind: ctx.structured ? 'structured' : 'text',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    await logIf(null, 'error');
    return openAiError(502, 'api_error', 'Upstream model request failed.', { code: 'upstream_error' });
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
    keyId: ctx.keyId,
    provider,
    model,
    streamed: true,
    responseKind: (ctx.structured ? 'structured' : 'text') as 'structured' | 'text',
  };
  const logIf = (response: string | null, status: 'ok' | 'error') =>
    ctx.logContent
      ? recordRequestLog({
          id: eventId,
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
      await recordUsage({
        ...base,
        usage: normalizeUsage(event.totalUsage ?? event.usage),
        costUsd: extractGatewayCost(event.providerMetadata),
        latencyMs: Date.now() - start,
        status: 'ok',
        gatewayRequestId: extractGatewayRequestId(event.providerMetadata),
      });
      await logIf(event.text, 'ok');
      scheduleChampionCapture(ctx, messages, 'responses', event.text, event.providerMetadata, start, eventId);
    },
    onError: async ({ error }) => {
      await recordUsage({
        ...base,
        usage: { ...ZERO_USAGE },
        latencyMs: Date.now() - start,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    },
  });

  // Drain regardless of client connection so onFinish (accounting) always fires.
  waitUntil(Promise.resolve(result.consumeStream()));

  const encoder = new TextEncoder();
  const resp = (status: 'in_progress' | 'completed', text: string | null, usage: ReturnType<typeof mapResponsesUsage> | null) =>
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
    });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0;
      const emit = (type: string, data: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(responsesSseEvent(type, { sequence_number: seq++, ...data })));
      let acc = '';
      try {
        emit('response.created', { response: resp('in_progress', null, null) });
        emit('response.in_progress', { response: resp('in_progress', null, null) });
        emit('response.output_item.added', {
          output_index: 0,
          item: { id: mid, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        });
        emit('response.content_part.added', {
          item_id: mid,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
        });
        for await (const delta of result.textStream) {
          if (delta) {
            acc += delta;
            emit('response.output_text.delta', {
              item_id: mid,
              output_index: 0,
              content_index: 0,
              delta,
              logprobs: [],
            });
          }
        }
        emit('response.output_text.done', {
          item_id: mid,
          output_index: 0,
          content_index: 0,
          text: acc,
          logprobs: [],
        });
        emit('response.content_part.done', {
          item_id: mid,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: acc, annotations: [], logprobs: [] },
        });
        emit('response.output_item.done', {
          output_index: 0,
          item: {
            id: mid,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: acc, annotations: [] }],
          },
        });
        let usage = { ...ZERO_USAGE };
        try {
          usage = normalizeUsage(await result.totalUsage);
        } catch {
          /* keep zero */
        }
        emit('response.completed', { response: resp('completed', acc, mapResponsesUsage(usage)) });
        controller.close();
      } catch {
        // Upstream/stream error or client disconnect. Accounting handled by
        // onFinish/onError via consumeStream(); just end the stream (no [DONE]).
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
