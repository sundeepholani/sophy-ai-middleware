import { describe, expect, it } from 'vitest';
import {
  fromTypeSafeResponse,
  modelSupportsAssessment,
  parseAssessmentRequest,
  summarizeAssets,
  toAssessmentResponse,
  toTypeSafeRequest,
} from '@/lib/gateway/assessments';
import type { AvailableModel } from '@/lib/gateway/capabilities';
import type { EvaluationRequest } from '@/lib/http/openai';

const MODEL = 'typesafe-ai/jev';

function model(id: string, type: string, tags: string[] = []): AvailableModel {
  return {
    id,
    name: id,
    provider: id.split('/')[0] ?? 'test',
    type,
    contextWindow: null,
    maxTokens: null,
    inputPerMTok: null,
    outputPerMTok: null,
    description: null,
    tags,
  };
}

/** A minimal well-formed body, spread-and-overridden per case. */
function body(over: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return {
    state: 'The support agent issued a full refund.',
    questions: { refunded: { type: 'boolean', instructions: 'Was a refund issued?' } },
    ...over,
  };
}

describe('assessment capability predicate', () => {
  it('accepts only the evaluation catalog type', () => {
    expect(modelSupportsAssessment(model(MODEL, 'evaluation'))).toBe(true);
    expect(modelSupportsAssessment(model('openai/gpt-5-mini', 'language'))).toBe(false);
    expect(modelSupportsAssessment(model('openai/text-embedding-3-small', 'embedding'))).toBe(
      false,
    );
  });
});

describe('parseAssessmentRequest — rejections', () => {
  it('requires state', () => {
    expect(parseAssessmentRequest({ questions: body().questions }, MODEL)).toMatchObject({
      ok: false,
      status: 400,
      code: 'missing_state',
      param: 'state',
    });
  });

  it('treats an explicit null state as missing', () => {
    expect(parseAssessmentRequest(body({ state: null }), MODEL)).toMatchObject({
      ok: false,
      code: 'missing_state',
    });
  });

  it('rejects a state that serializes beyond the cap', () => {
    expect(parseAssessmentRequest(body({ state: 'x'.repeat(200_001) }), MODEL)).toMatchObject({
      ok: false,
      code: 'state_too_large',
      param: 'state',
    });
  });

  it('requires questions', () => {
    expect(parseAssessmentRequest({ state: 'x' }, MODEL)).toMatchObject({
      ok: false,
      code: 'missing_questions',
      param: 'questions',
    });
  });

  it('rejects an array of questions', () => {
    expect(
      parseAssessmentRequest(
        body({ questions: [] as unknown as EvaluationRequest['questions'] }),
        MODEL,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_questions' });
  });

  it('rejects an empty questions object', () => {
    expect(parseAssessmentRequest(body({ questions: {} }), MODEL)).toMatchObject({
      ok: false,
      code: 'questions_empty',
    });
  });

  it('rejects more than 32 questions', () => {
    const questions = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [
        `q${i}`,
        { type: 'boolean' as const, instructions: 'ok?' },
      ]),
    );
    expect(parseAssessmentRequest(body({ questions }), MODEL)).toMatchObject({
      ok: false,
      code: 'too_many_questions',
    });
  });

  it('requires non-empty instructions on each question', () => {
    expect(
      parseAssessmentRequest(
        body({ questions: { refunded: { type: 'boolean', instructions: '  ' } } }),
        MODEL,
      ),
    ).toMatchObject({
      ok: false,
      code: 'missing_instructions',
      param: 'questions.refunded.instructions',
    });
  });

  it('rejects an unknown question type', () => {
    expect(
      parseAssessmentRequest(
        body({
          questions: {
            refunded: { type: 'rubric', instructions: 'x' } as unknown as never,
          },
        }),
        MODEL,
      ),
    ).toMatchObject({
      ok: false,
      code: 'unsupported_question_type',
      param: 'questions.refunded.type',
    });
  });

  it('rejects a boolean criteria missing a case', () => {
    expect(
      parseAssessmentRequest(
        body({
          questions: {
            passed: {
              type: 'boolean',
              instructions: 'Did the build pass?',
              criteria: { true: 'exit 0' } as unknown as { true: string; false: string },
            },
          },
        }),
        MODEL,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_criteria' });
  });

  it('rejects a choice with fewer than two options', () => {
    expect(
      parseAssessmentRequest(
        body({
          questions: {
            route: { type: 'choice', instructions: 'Route it.', criteria: { billing: 'money' } },
          },
        }),
        MODEL,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_criteria', param: 'questions.route.criteria' });
  });

  it('rejects a score with fewer than two rungs', () => {
    expect(
      parseAssessmentRequest(
        body({
          questions: { quality: { type: 'score', instructions: 'Rate it.', criteria: ['poor'] } },
        }),
        MODEL,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_criteria' });
  });

  it('rejects a score whose rungs are not all strings', () => {
    expect(
      parseAssessmentRequest(
        body({
          questions: {
            quality: {
              type: 'score',
              instructions: 'Rate it.',
              criteria: ['poor', 2] as unknown as string[],
            },
          },
        }),
        MODEL,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_criteria' });
  });

  it('rejects providerOptions addressed to another provider', () => {
    expect(
      parseAssessmentRequest(body({ providerOptions: { openai: { foo: 1 } } }), MODEL),
    ).toMatchObject({
      ok: false,
      code: 'unsupported_provider_options',
      param: 'providerOptions.openai',
    });
  });
});

describe('parseAssessmentRequest — acceptances', () => {
  it('accepts a boolean question without criteria', () => {
    const result = parseAssessmentRequest(body(), MODEL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('The support agent issued a full refund.');
    expect(Object.keys(result.value.questions)).toEqual(['refunded']);
  });

  it('accepts structured (object) state', () => {
    const state = { order: { id: 'A-1', total: 42.5, status: 'refunded' }, agent: 'bot-7' };
    const result = parseAssessmentRequest(body({ state }), MODEL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual(state);
  });

  it('accepts all three question types in one request', () => {
    const result = parseAssessmentRequest(
      body({
        questions: {
          authIssue: { type: 'boolean', instructions: 'Login problem?' },
          route: {
            type: 'choice',
            instructions: 'Route it.',
            criteria: { billing: 'money', shipping: 'delivery' },
          },
          urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] },
        },
      }),
      MODEL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.questions)).toEqual(['authIssue', 'route', 'urgency']);
  });

  it('ignores the client model field entirely (key owns the model)', () => {
    const result = parseAssessmentRequest(body({ model: 'someone-else/model' }), MODEL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).not.toContain('someone-else');
  });

  it('adds no gateway attribution namespace of its own', () => {
    const result = parseAssessmentRequest(body(), MODEL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providerOptions.gateway).toBeUndefined();
    expect(result.value.providerOptions).toEqual({});
  });

  it("passes through knobs in the key model's own namespace", () => {
    const result = parseAssessmentRequest(
      body({ providerOptions: { 'typesafe-ai': { zeroDataRetention: true } } }),
      MODEL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providerOptions['typesafe-ai']).toEqual({ zeroDataRetention: true });
  });
});

describe('toAssessmentResponse', () => {
  it('preserves each answer shape and reports the key model, not the upstream echo', () => {
    const payload = toAssessmentResponse(
      {
        model: 'upstream/echo',
        answers: {
          refunded: { type: 'boolean', probability: 0.99 },
          route: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 1, shipping: 0 },
          },
          quality: { type: 'score', score: 2.97, probabilities: { '2': 0.02, '3': 0.98 } },
        },
        usage: { inputTokens: 250, outputTokens: 25 },
      },
      MODEL,
      ['refunded', 'route', 'quality'],
    );
    expect(payload).toEqual({
      model: MODEL,
      answers: {
        refunded: { type: 'boolean', probability: 0.99 },
        route: { type: 'choice', choice: 'billing', probabilities: { billing: 1, shipping: 0 } },
        quality: { type: 'score', score: 2.97, probabilities: { '2': 0.02, '3': 0.98 } },
      },
      usage: { inputTokens: 250, outputTokens: 25, totalTokens: 275 },
    });
  });

  it('never echoes providerMetadata to the client', () => {
    const payload = toAssessmentResponse(
      {
        answers: { refunded: { type: 'boolean', probability: 1 } },
        usage: { inputTokens: 1, outputTokens: 0 },
        providerMetadata: { gateway: { cost: '0.00001155', generationId: 'gen_secret' } },
      },
      MODEL,
      ['refunded'],
    );
    expect(JSON.stringify(payload)).not.toContain('gen_secret');
    expect(JSON.stringify(payload)).not.toContain('providerMetadata');
  });

  it('zeroes non-finite or absent usage rather than serializing NaN', () => {
    expect(
      toAssessmentResponse(
        { answers: { a: { type: 'boolean', probability: 0.5 } } },
        MODEL,
        ['a'],
      )?.usage,
    ).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

    expect(
      toAssessmentResponse(
        {
          answers: { a: { type: 'boolean', probability: 0.5 } },
          usage: { inputTokens: Number.NaN, outputTokens: 'x' },
        },
        MODEL,
        ['a'],
      )?.usage,
    ).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('returns null when an asked question has no answer', () => {
    expect(
      toAssessmentResponse(
        { answers: { refunded: { type: 'boolean', probability: 1 } } },
        MODEL,
        ['refunded', 'missing'],
      ),
    ).toBeNull();
  });

  it('returns null on an unusable body or an unrecognized answer type', () => {
    expect(toAssessmentResponse({}, MODEL, ['a'])).toBeNull();
    expect(toAssessmentResponse({ answers: 'nope' }, MODEL, ['a'])).toBeNull();
    expect(
      toAssessmentResponse({ answers: { a: { type: 'histogram' } } }, MODEL, ['a']),
    ).toBeNull();
    expect(
      toAssessmentResponse({ answers: { a: { type: 'choice', probabilities: {} } } }, MODEL, ['a']),
    ).toBeNull();
  });
});

// A 1x1 PNG / JPEG header is enough: Sophy checks the signature, TypeSafe the pixels.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';

function imageBody(over: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return body({
    state: { photo: 'selfie-1' },
    questions: {
      groomed: { type: 'boolean', instructions: 'Is the person in `photo` well groomed?' },
    },
    assets: { 'selfie-1': { type: 'image', format: 'png', data_base64: PNG_B64 } },
    ...over,
  });
}

describe('parseAssessmentRequest — image assets', () => {
  it('accepts a referenced PNG or JPEG for a TypeSafe model', () => {
    const png = parseAssessmentRequest(imageBody(), 'typesafe-ai/jev-1.14.0');
    expect(png.ok && png.value.assets).toEqual({
      'selfie-1': { type: 'image', format: 'png', data_base64: PNG_B64 },
    });
    const jpeg = parseAssessmentRequest(
      imageBody({ assets: { 'selfie-1': { type: 'image', format: 'jpeg', data_base64: JPEG_B64 } } }),
      'typesafe-ai/jev-1.13.0',
    );
    expect(jpeg.ok).toBe(true);
  });

  it('leaves assets off a request that sent none', () => {
    const r = parseAssessmentRequest(body(), MODEL);
    expect(r.ok && 'assets' in r.value).toBe(false);
  });

  it('rejects assets for a non-TypeSafe evaluation model', () => {
    const r = parseAssessmentRequest(imageBody(), 'other-ai/judge-1');
    expect(r).toMatchObject({ ok: false, status: 400, code: 'assets_not_supported', param: 'assets' });
  });

  it('rejects an asset nothing refers to', () => {
    const r = parseAssessmentRequest(imageBody({ state: 'no reference here' }), MODEL);
    expect(r).toMatchObject({ ok: false, code: 'unreferenced_asset', param: 'assets.selfie-1' });
  });

  it('accepts a reference made from a question instead of state', () => {
    const r = parseAssessmentRequest(
      imageBody({
        state: 'Attendance check-in',
        questions: { groomed: { type: 'boolean', instructions: 'Is the person in selfie-1 groomed?' } },
      }),
      MODEL,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects a data: URL, whitespace or url-safe base64', () => {
    for (const data of [`data:image/png;base64,${PNG_B64}`, `${PNG_B64.slice(0, 8)}\n${PNG_B64.slice(8)}`, PNG_B64.replace(/\+/g, '-').replace(/\//g, '_')]) {
      const r = parseAssessmentRequest(
        imageBody({ assets: { 'selfie-1': { type: 'image', format: 'png', data_base64: data } } }),
        MODEL,
      );
      expect(r).toMatchObject({ ok: false, code: 'invalid_asset_data' });
    }
  });

  it('rejects bytes that do not match the declared format', () => {
    const r = parseAssessmentRequest(
      imageBody({ assets: { 'selfie-1': { type: 'image', format: 'jpg', data_base64: PNG_B64 } } }),
      MODEL,
    );
    expect(r).toMatchObject({ ok: false, code: 'asset_format_mismatch' });
  });

  it('rejects unsupported formats, non-image types and bad keys', () => {
    const webp = parseAssessmentRequest(
      imageBody({ assets: { 'selfie-1': { type: 'image', format: 'webp' as 'png', data_base64: PNG_B64 } } }),
      MODEL,
    );
    expect(webp).toMatchObject({ ok: false, code: 'unsupported_asset_format' });
    const notImage = parseAssessmentRequest(
      imageBody({ assets: { 'selfie-1': { type: 'audio' as 'image', format: 'png', data_base64: PNG_B64 } } }),
      MODEL,
    );
    expect(notImage).toMatchObject({ ok: false, code: 'invalid_asset' });
    const badKey = parseAssessmentRequest(
      imageBody({ state: { photo: 'a b' }, assets: { 'a b': { type: 'image', format: 'png', data_base64: PNG_B64 } } }),
      MODEL,
    );
    expect(badKey).toMatchObject({ ok: false, code: 'invalid_asset_key' });
  });

  it('rejects more than 8 assets', () => {
    const assets = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`img-${i}`, { type: 'image' as const, format: 'png' as const, data_base64: PNG_B64 }]),
    );
    const r = parseAssessmentRequest(imageBody({ state: Object.keys(assets), assets }), MODEL);
    expect(r).toMatchObject({ ok: false, code: 'too_many_assets' });
  });
});

describe('TypeSafe shape translation', () => {
  it('sends boolean questions as noul and carries assets and providerOptions', () => {
    const parsed = parseAssessmentRequest(
      imageBody({ providerOptions: { 'typesafe-ai': { x: 1 } } }),
      MODEL,
    );
    if (!parsed.ok) throw new Error('expected ok');
    expect(toTypeSafeRequest(parsed.value, MODEL)).toEqual({
      model: MODEL,
      state: { photo: 'selfie-1' },
      questions: {
        groomed: { type: 'noul', instructions: 'Is the person in `photo` well groomed?' },
      },
      assets: { 'selfie-1': { type: 'image', format: 'png', data_base64: PNG_B64 } },
      providerOptions: { 'typesafe-ai': { x: 1 } },
    });
  });

  it('maps a TypeSafe response onto the evaluate shape', () => {
    const raw = fromTypeSafeResponse({
      model: MODEL,
      answers: {
        groomed: { type: 'noul', noul: 0.91 },
        tidy: { type: 'score', score: 1.1, confidence: 0.3, legend: {}, probabilities: { '0': 0.2, '1': 0.5, '2': 0.3 } },
      },
      usage: { input_tokens: 655, output_tokens: 62 },
      provider_metadata: { gateway: { cost: '0.00002751', generationId: 'gen_x' } },
    });
    expect(toAssessmentResponse(raw, MODEL, ['groomed', 'tidy'])).toEqual({
      model: MODEL,
      answers: {
        groomed: { type: 'boolean', probability: 0.91 },
        tidy: { type: 'score', score: 1.1, probabilities: { '0': 0.2, '1': 0.5, '2': 0.3 } },
      },
      usage: { inputTokens: 655, outputTokens: 62, totalTokens: 717 },
    });
    expect(raw.providerMetadata).toEqual({ gateway: { cost: '0.00002751', generationId: 'gen_x' } });
  });

  it('summarizes assets for the log by decoded size, never bytes', () => {
    expect(summarizeAssets(undefined)).toBeUndefined();
    const summary = summarizeAssets({ a: { type: 'image', format: 'png', data_base64: PNG_B64 } });
    expect(summary).toEqual({ a: { format: 'png', bytes: Buffer.from(PNG_B64, 'base64').length } });
  });
});
