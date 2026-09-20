import { describe, expect, it } from 'vitest';
import {
  modelSupportsAssessment,
  parseAssessmentRequest,
  toAssessmentResponse,
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
