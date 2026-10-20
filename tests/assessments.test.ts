import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessmentCapability,
  fromTypeSafeResponse,
  modelSupportsAssessment,
  parseAssessmentRequest,
  summarizeAssets,
  toAssessmentResponse,
  toClefRequest,
  toTypeSafeRequest,
} from '@/lib/gateway/assessments';
import type { AvailableModel } from '@/lib/gateway/capabilities';
import { getCloudflareModel } from '@/lib/gateway/cloudflare-models';
import type { AssessmentAsset, AssessmentQuestion, EvaluationRequest } from '@/lib/http/openai';

const MODEL = 'typesafe-ai/jev';
const CLEF = '@cf/cloudflare/clef';
const CLEF_FLASH = '@cf/cloudflare/clef-flash';
const CLEF_OMNI = '@cf/cloudflare/clef-omni';
const CLAIRIC = '@cf/cloudflare/clairic';

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
/** 34 bytes: 'RIFF' + size + 'WEBP' + 'VP8L…' (bytes 0-3 RIFF, 8-11 WEBP; strict base64). */
const WEBP_B64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

/** Strict base64 with a PNG signature that decodes to exactly `bytes` bytes. `bytes` must be a multiple of 3. */
function pngOfBytes(bytes: number): string {
  return 'iVBORw0KGgo' + 'A'.repeat((bytes / 3) * 4 - 11);
}

/** One image asset. */
function img(format: AssessmentAsset['format'], data_base64: string): AssessmentAsset {
  return { type: 'image', format, data_base64 };
}

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
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      code: 'assets_not_supported',
      param: 'assets',
      message:
        "Image assets are only supported for TypeSafe Jev and Cloudflare Clef keys; this key's model cannot accept them.",
    });
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

  it('validates a multi-MB Jev image without overflowing the regexp stack', () => {
    // 4,800,000 characters: the old STRICT_BASE64 regex threw RangeError (a 500) here.
    const r = parseAssessmentRequest(
      imageBody({ assets: { 'selfie-1': img('png', pngOfBytes(3_600_000)) } }),
      MODEL,
    );
    expect(r.ok).toBe(true);
  });

  it('keeps a Jev asset keyed __proto__', () => {
    const assets = JSON.parse(
      `{"__proto__":{"type":"image","format":"png","data_base64":"${PNG_B64}"}}`,
    ) as Record<string, AssessmentAsset>;
    const r = parseAssessmentRequest(imageBody({ state: 'Look at __proto__ please', assets }), MODEL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value.assets ?? {})).toEqual(['__proto__']);
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

  it('maps a TypeSafe response onto the evaluate shape, keeping confidence and dropping legend', () => {
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
        tidy: {
          type: 'score',
          score: 1.1,
          probabilities: { '0': 0.2, '1': 0.5, '2': 0.3 },
          confidence: 0.3,
        },
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

// ---- Cloudflare Workers AI Clef (D8) -----------------------------------------

/** cf-live/clef-text.response.json (key @cf/cloudflare/clef), inlined: the probe scratchpad may vanish. */
const CLEF_TEXT_RESULT = {
  model: 'clef',
  answers: {
    urgent: { type: 'noul', noul: 0.8998 },
    team: {
      type: 'choice',
      choice: 'technical',
      probabilities: { billing: 0.0605, technical: 0.931, sales: 0.0085 },
      confidence: 0.8058,
    },
    severity: {
      type: 'score',
      score: 2.9603,
      legend: { '0': 'No impact', '1': 'Minor', '2': 'Major', '3': 'Critical' },
      probabilities: { '0': 0.0035, '1': 0.0035, '2': 0.0222, '3': 0.9708 },
      confidence: 0.9239,
    },
  },
  usage: { input_tokens: 381, output_tokens: 0 },
};

/** CLEF_TEXT_RESULT on Sophy's wire: the key's model, noul as boolean, confidence kept, legend dropped. */
const CLEF_TEXT_PAYLOAD = {
  model: CLEF,
  answers: {
    urgent: { type: 'boolean', probability: 0.8998 },
    team: {
      type: 'choice',
      choice: 'technical',
      probabilities: { billing: 0.0605, technical: 0.931, sales: 0.0085 },
      confidence: 0.8058,
    },
    severity: {
      type: 'score',
      score: 2.9603,
      probabilities: { '0': 0.0035, '1': 0.0035, '2': 0.0222, '3': 0.9708 },
      confidence: 0.9239,
    },
  },
  usage: { inputTokens: 381, outputTokens: 0, totalTokens: 381 },
};

describe('assessment capability — Cloudflare registry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Any catalog fetch would fail the guard's promise of a synchronous registry lookup. */
  function forbidNetwork() {
    const fetchMock = vi.fn(async () => {
      throw new Error('no network in tests');
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('classifies the three Clef models as evaluation without fetching the catalog', async () => {
    const fetchMock = forbidNetwork();
    for (const id of [CLEF, CLEF_FLASH, CLEF_OMNI]) {
      await expect(assessmentCapability(id)).resolves.toBe('assessment');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed for Clairic, unregistered and inexact @cf/ ids', async () => {
    const fetchMock = forbidNetwork();
    for (const id of [
      CLAIRIC,
      '@cf/cloudflare/unknown',
      '@cf/cloudflare/CLEF',
      '@cf/cloudflare/clef ',
      '@cf/meta/llama-3.1-8b-instruct',
    ]) {
      await expect(assessmentCapability(id)).resolves.toBe('not_assessment');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseAssessmentRequest — Cloudflare Clef keys', () => {
  const yes = { type: 'boolean' as const, instructions: 'x' };
  const ID_MESSAGE = 'Question ids for this model must be 1-100 letters, digits, "_", "." or "-".';
  const CHOICE_MESSAGE =
    'questions.route.criteria must map 2 to 255 non-empty option ids to descriptions for this model.';
  /** `n` choice options o0…o(n-1). */
  const options = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, `option ${i}`]));
  /** `n` score labels '0'…'(n-1)'. */
  const levels = (n: number) => Array.from({ length: n }, (_, i) => String(i));
  /** The pre-cap's worked boundary: 94 characters of body around the state. */
  const q = { q: { type: 'boolean' as const, instructions: 'Is it ok?' } };
  const fiveImages = () =>
    Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [k, img('png', PNG_B64)]));

  it('accepts the same minimal body as Jev', () => {
    const r = parseAssessmentRequest(body(), CLEF);
    expect(r).toEqual({
      ok: true,
      value: { state: body().state, questions: body().questions, providerOptions: {} },
    });
    expect(r.ok && 'assets' in r.value).toBe(false);
  });

  it('fails closed with model_not_evaluation for Clairic and unregistered @cf/ ids', () => {
    for (const id of [CLAIRIC, '@cf/cloudflare/unknown', '@cf/cloudflare/CLEF']) {
      expect(parseAssessmentRequest(body(), id)).toEqual({
        ok: false,
        status: 400,
        code: 'model_not_evaluation',
        message: "This key's model is not an evaluation model.",
      });
    }
  });

  it('checks the model before the body', () => {
    expect(parseAssessmentRequest({}, CLAIRIC)).toMatchObject({
      ok: false,
      code: 'model_not_evaluation',
    });
  });

  it('runs the existing checks before the Clef ones', () => {
    expect(parseAssessmentRequest({ questions: { 'bad id': yes } }, CLEF)).toMatchObject({
      ok: false,
      code: 'missing_state',
    });
  });

  it('finishes every checkQuestion before any Clef id rule', () => {
    expect(
      parseAssessmentRequest(
        body({ questions: { 'bad id': yes, good: { type: 'boolean', instructions: ' ' } } }),
        CLEF,
      ),
    ).toMatchObject({ ok: false, code: 'missing_instructions', param: 'questions.good.instructions' });
  });

  it('rejects question ids outside [A-Za-z0-9_.-]{1,100}', () => {
    for (const id of ['bad id', 'a/b', 'é', 'x'.repeat(101), '']) {
      expect(parseAssessmentRequest(body({ questions: { [id]: yes } }), CLEF)).toEqual({
        ok: false,
        status: 400,
        code: 'invalid_question_id',
        param: `questions.${id}`,
        message: ID_MESSAGE,
      });
    }
  });

  it('accepts letters, digits, "_", "." and "-" up to 100 characters', () => {
    for (const id of ['a', 'A_b.c-9', 'x'.repeat(100)]) {
      expect(parseAssessmentRequest(body({ questions: { [id]: yes } }), CLEF).ok).toBe(true);
    }
  });

  it('does not apply Clef rules to Jev keys', () => {
    const cases: Record<string, AssessmentQuestion>[] = [
      { 'bad id': yes },
      { route: { type: 'choice', instructions: 'Route it.', criteria: options(256) } },
      { severity: { type: 'score', instructions: 'How bad?', criteria: levels(11) } },
      { route: { type: 'choice', instructions: 'Route it.', criteria: { '': 'n', billing: 'b' } } },
    ];
    for (const questions of cases) {
      expect(parseAssessmentRequest(body({ questions }), MODEL).ok).toBe(true);
    }
  });

  it('caps choice questions at 255 options', () => {
    const route = (n: number) => ({
      route: { type: 'choice' as const, instructions: 'Route it.', criteria: options(n) },
    });
    expect(parseAssessmentRequest(body({ questions: route(256) }), CLEF)).toEqual({
      ok: false,
      status: 400,
      code: 'invalid_criteria',
      param: 'questions.route.criteria',
      message: CHOICE_MESSAGE,
    });
    expect(parseAssessmentRequest(body({ questions: route(255) }), CLEF).ok).toBe(true);
  });

  it('rejects an empty choice option id', () => {
    expect(
      parseAssessmentRequest(
        body({
          questions: {
            route: { type: 'choice', instructions: 'Route it.', criteria: { '': 'nothing', billing: 'money' } },
          },
        }),
        CLEF,
      ),
    ).toEqual({
      ok: false,
      status: 400,
      code: 'invalid_criteria',
      param: 'questions.route.criteria',
      message: CHOICE_MESSAGE,
    });
  });

  it('caps score questions at 10 levels', () => {
    const severity = (n: number) => ({
      severity: { type: 'score' as const, instructions: 'How bad?', criteria: levels(n) },
    });
    expect(parseAssessmentRequest(body({ questions: severity(11) }), CLEF)).toEqual({
      ok: false,
      status: 400,
      code: 'invalid_criteria',
      param: 'questions.severity.criteria',
      message: 'questions.severity.criteria must have 2 to 10 levels for this model.',
    });
    expect(parseAssessmentRequest(body({ questions: severity(10) }), CLEF).ok).toBe(true);
  });

  it('keeps the 32-question cap for Clef', () => {
    const booleans = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, yes]));
    expect(parseAssessmentRequest(body({ questions: booleans(33) }), CLEF)).toMatchObject({
      ok: false,
      code: 'too_many_questions',
    });
    expect(parseAssessmentRequest(body({ questions: booleans(32) }), CLEF).ok).toBe(true);
  });

  it('rejects providerOptions in any form', () => {
    for (const providerOptions of [{}, { cloudflare: {} }, { 'typesafe-ai': { x: 1 } }, null, 'x']) {
      expect(
        parseAssessmentRequest(body({ providerOptions: providerOptions as never }), CLEF),
      ).toEqual({
        ok: false,
        status: 400,
        code: 'unsupported_provider_options',
        param: 'providerOptions',
        message: "providerOptions are not supported for this key's model.",
      });
    }
  });

  it('rejects Cloudflare-native media fields', () => {
    const cases: [string, unknown][] = [
      ['images', []],
      ['audio', []],
      ['videos', []],
      ['images', null],
    ];
    for (const [field, value] of cases) {
      const request = { ...body(), [field]: value } as unknown as EvaluationRequest;
      expect(parseAssessmentRequest(request, CLEF)).toEqual({
        ok: false,
        status: 400,
        code: 'unsupported_media_field',
        param: field,
        message: `Send images in the keyed "assets" field; "${field}" is not accepted.`,
      });
    }
  });

  it('ignores unknown top-level media fields on Jev keys, as today', () => {
    const request = { ...body(), images: [] } as unknown as EvaluationRequest;
    expect(parseAssessmentRequest(request, MODEL).ok).toBe(true);
  });

  it('checks media fields before assets', () => {
    const request = { ...body(), images: [], assets: 'nope' } as unknown as EvaluationRequest;
    expect(parseAssessmentRequest(request, CLEF)).toMatchObject({
      ok: false,
      code: 'unsupported_media_field',
    });
  });

  it('accepts up to four png, jpg, jpeg and webp images with no reference', () => {
    const r = parseAssessmentRequest(
      body({
        state: 'no reference here',
        assets: {
          a: img('png', PNG_B64),
          b: img('jpg', JPEG_B64),
          c: img('JPEG' as 'jpeg', JPEG_B64),
          d: img('webp', WEBP_B64),
        },
      }),
      CLEF,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.assets?.c.format).toBe('jpeg');
    expect(r.value.assets?.d).toEqual({ type: 'image', format: 'webp', data_base64: WEBP_B64 });
  });

  it('rejects a fifth image', () => {
    expect(parseAssessmentRequest(body({ assets: fiveImages() }), CLEF)).toEqual({
      ok: false,
      status: 400,
      code: 'too_many_assets',
      param: 'assets',
      message: 'assets must not contain more than 4 entries for this model.',
    });
  });

  it('rejects non-image assets', () => {
    expect(
      parseAssessmentRequest(
        body({ assets: { a: { type: 'audio' as 'image', format: 'png', data_base64: PNG_B64 } } }),
        CLEF,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_asset', param: 'assets.a' });
  });

  it('checks the WebP RIFF/WEBP signature', () => {
    expect(parseAssessmentRequest(body({ assets: { a: img('webp', PNG_B64) } }), CLEF)).toEqual({
      ok: false,
      status: 400,
      code: 'asset_format_mismatch',
      param: 'assets.a.data_base64',
      message: 'assets.a.data_base64 is not a WebP image.',
    });
    expect(parseAssessmentRequest(body({ assets: { a: img('png', WEBP_B64) } }), CLEF)).toMatchObject({
      ok: false,
      code: 'asset_format_mismatch',
    });
  });

  it('caps each image at 4 MiB decoded', () => {
    expect(
      parseAssessmentRequest(body({ assets: { big: img('png', pngOfBytes(4_194_306)) } }), CLEF),
    ).toEqual({
      ok: false,
      status: 400,
      code: 'asset_too_large',
      param: 'assets.big',
      message: 'assets.big must not exceed 4 MiB once decoded.',
    });
    expect(
      parseAssessmentRequest(body({ assets: { big: img('png', pngOfBytes(4_194_303)) } }), CLEF).ok,
    ).toBe(true);
  });

  it('caps all images at 8 MiB decoded in total', () => {
    const threeMiB = pngOfBytes(3_145_728);
    expect(
      parseAssessmentRequest(
        body({ assets: { a: img('png', threeMiB), b: img('png', threeMiB), c: img('png', threeMiB) } }),
        CLEF,
      ),
    ).toEqual({
      ok: false,
      status: 400,
      code: 'assets_too_large',
      param: 'assets',
      message: 'assets must not exceed 8 MiB in total once decoded.',
    });
    const underFourMiB = pngOfBytes(4_194_303);
    expect(
      parseAssessmentRequest(
        body({ assets: { a: img('png', underFourMiB), b: img('png', underFourMiB) } }),
        CLEF,
      ).ok,
    ).toBe(true);
  });

  it("keeps Jev's asset rules on Jev keys", () => {
    expect(
      parseAssessmentRequest(imageBody({ assets: { 'selfie-1': img('webp', WEBP_B64) } }), MODEL),
    ).toMatchObject({
      ok: false,
      code: 'unsupported_asset_format',
      message: 'assets.selfie-1.format must be "png", "jpg" or "jpeg".',
    });
    expect(parseAssessmentRequest(imageBody({ state: 'no reference here' }), MODEL)).toMatchObject({
      ok: false,
      code: 'unreferenced_asset',
    });
  });

  it("pre-caps the request at clef-flash's context window", () => {
    expect(parseAssessmentRequest({ state: 'x'.repeat(98_210), questions: q }, CLEF_FLASH).ok).toBe(
      true,
    );
    expect(parseAssessmentRequest({ state: 'x'.repeat(98_211), questions: q }, CLEF_FLASH)).toEqual({
      ok: false,
      status: 400,
      code: 'state_too_large',
      param: 'state',
      message:
        'state is too large for Clef Flash: the request is estimated at 24577 tokens and the model accepts at most 24576.',
    });
  });

  it("applies each model's own window", () => {
    for (const id of [CLEF, CLEF_OMNI]) {
      expect(parseAssessmentRequest({ state: 'x'.repeat(98_211), questions: q }, id).ok).toBe(true);
    }
  });

  it('counts questions toward the pre-cap, not only state', () => {
    const long = (n: number) =>
      Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [
          `q${i}`,
          { type: 'boolean' as const, instructions: 'i'.repeat(n) },
        ]),
      );
    expect(parseAssessmentRequest({ state: 'x', questions: long(8_192) }, CLEF)).toEqual({
      ok: false,
      status: 400,
      code: 'state_too_large',
      param: 'state',
      message:
        'state is too large for Clef: the request is estimated at 65864 tokens and the model accepts at most 65536.',
    });
    // Estimated at 65,528 tokens.
    expect(parseAssessmentRequest({ state: 'x', questions: long(8_150) }, CLEF).ok).toBe(true);
  });

  it('does not count image bytes toward the pre-cap', () => {
    // 24,524 tokens without the image; its 4,000,000 base64 characters would add a million.
    expect(
      parseAssessmentRequest(
        { state: 'x'.repeat(98_000), questions: q, assets: { big: img('png', pngOfBytes(3_000_000)) } },
        CLEF_FLASH,
      ).ok,
    ).toBe(true);
  });

  it('runs the pre-cap last', () => {
    const over = { state: 'x'.repeat(98_211), questions: q };
    expect(
      parseAssessmentRequest({ ...over, questions: { ...q, 'bad id': yes } }, CLEF_FLASH),
    ).toMatchObject({ ok: false, code: 'invalid_question_id' });
    expect(parseAssessmentRequest({ ...over, assets: fiveImages() }, CLEF_FLASH)).toMatchObject({
      ok: false,
      code: 'too_many_assets',
    });
  });
});

describe('toClefRequest', () => {
  it('sends the registry selector and System One questions, never providerOptions or assets', () => {
    const state = 'Customer: my card was charged twice for one order, please refund.';
    const team = {
      type: 'choice' as const,
      instructions: 'Which team should handle this?',
      criteria: { billing: 'payments', tech: 'bugs' },
    };
    const sev = { type: 'score' as const, instructions: 'How severe?', criteria: ['low', 'high'] };
    const parsed = parseAssessmentRequest(
      {
        state,
        questions: {
          refund: { type: 'boolean', instructions: 'Refund?', criteria: { true: 'yes', false: 'no' } },
          team,
          sev,
        },
      },
      CLEF_FLASH,
    );
    if (!parsed.ok) throw new Error('expected ok');
    const sent = toClefRequest(parsed.value, getCloudflareModel(CLEF_FLASH)!);
    expect(sent).toEqual({
      model: 'clef-flash',
      state,
      questions: {
        refund: { type: 'noul', instructions: 'Refund?', criteria: { true: 'yes', false: 'no' } },
        team,
        sev,
      },
    });
    expect(sent).not.toHaveProperty('images');
    expect(sent).not.toHaveProperty('providerOptions');
    expect(sent).not.toHaveProperty('assets');
  });

  it("uses each model's own selector", () => {
    const parsed = parseAssessmentRequest(body(), CLEF);
    if (!parsed.ok) throw new Error('expected ok');
    for (const [id, selector] of [
      [CLEF, 'clef'],
      [CLEF_FLASH, 'clef-flash'],
      [CLEF_OMNI, 'clef-omni'],
    ] as const) {
      expect(toClefRequest(parsed.value, getCloudflareModel(id)!).model).toBe(selector);
    }
  });

  it('maps assets to images[] in Object.keys order', () => {
    const parsed = parseAssessmentRequest(
      body({
        assets: {
          b: img('webp', WEBP_B64),
          '10': img('jpg', JPEG_B64),
          a: img('jpeg', JPEG_B64),
          '2': img('png', PNG_B64),
        },
      }),
      CLEF,
    );
    if (!parsed.ok) throw new Error('expected ok');
    const sent = toClefRequest(parsed.value, getCloudflareModel(CLEF)!);
    // Integer-like keys enumerate first, ascending: 2, 10, b, a.
    expect(sent.images).toEqual([
      { content_type: 'image/png', base64: PNG_B64 },
      { content_type: 'image/jpeg', base64: JPEG_B64 },
      { content_type: 'image/webp', base64: WEBP_B64 },
      { content_type: 'image/jpeg', base64: JPEG_B64 },
    ]);
    const text = JSON.stringify(sent);
    expect(text).not.toContain('"assets"');
    expect(text).not.toContain('data_base64');
  });

  it("does not change the client's question objects", () => {
    const parsed = parseAssessmentRequest(
      body({ questions: { refund: { type: 'boolean', instructions: 'Refund?' } } }),
      CLEF,
    );
    if (!parsed.ok) throw new Error('expected ok');
    toClefRequest(parsed.value, getCloudflareModel(CLEF)!);
    expect(parsed.value.questions.refund.type).toBe('boolean');
  });
});

describe('toAssessmentResponse — confidence', () => {
  it('maps a live Clef result, keeping confidence and dropping legend', () => {
    expect(
      toAssessmentResponse(fromTypeSafeResponse(CLEF_TEXT_RESULT), CLEF, ['urgent', 'team', 'severity']),
    ).toEqual(CLEF_TEXT_PAYLOAD);
  });

  it('keeps confidence for every model', () => {
    const payload = toAssessmentResponse(
      {
        answers: {
          route: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 1, shipping: 0 },
            confidence: 0.7,
          },
        },
      },
      MODEL,
      ['route'],
    );
    expect(payload?.answers.route).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 1, shipping: 0 },
      confidence: 0.7,
    });
  });

  it('omits a confidence that is not a finite number', () => {
    for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, 'high', null]) {
      const payload = toAssessmentResponse(
        {
          answers: {
            route: {
              type: 'choice',
              choice: 'billing',
              probabilities: { billing: 1, shipping: 0 },
              confidence,
            },
            quality: { type: 'score', score: 1, probabilities: { '0': 0, '1': 1 }, confidence },
          },
        },
        CLEF,
        ['route', 'quality'],
      );
      expect(payload).not.toBeNull();
      expect(payload?.answers.route).not.toHaveProperty('confidence');
      expect(payload?.answers.quality).not.toHaveProperty('confidence');
    }
  });

  it('never adds confidence to boolean answers', () => {
    const payload = toAssessmentResponse(
      { answers: { ok: { type: 'boolean', probability: 0.5, confidence: 0.9 } } },
      CLEF,
      ['ok'],
    );
    expect(payload?.answers.ok).toStrictEqual({ type: 'boolean', probability: 0.5 });
  });

  it('keeps the answer of a question named __proto__', () => {
    for (const model of [CLEF, MODEL]) {
      const raw = fromTypeSafeResponse(
        JSON.parse(
          '{"answers":{"__proto__":{"type":"noul","noul":0.9}},"usage":{"input_tokens":1,"output_tokens":0}}',
        ),
      );
      const payload = toAssessmentResponse(raw, model, ['__proto__']);
      expect(payload).not.toBeNull();
      expect(Object.keys(payload?.answers ?? {})).toEqual(['__proto__']);
      expect(JSON.stringify(payload)).toContain('"__proto__":{"type":"boolean","probability":0.9}');
    }
  });

  it('treats a missing __proto__ answer as unusable', () => {
    expect(toAssessmentResponse({ answers: {} }, CLEF, ['__proto__'])).toBeNull();
    expect(toAssessmentResponse({ answers: {} }, CLEF, ['constructor'])).toBeNull();
  });
});
