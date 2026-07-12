import { describe, it, expect } from 'vitest';
import type { LanguageModelUsage } from 'ai';
import { NoOutputGeneratedError, NoObjectGeneratedError } from 'ai';
import { readStructuredOutput } from '@/lib/gateway/structured';

/**
 * A strict structured attempt whose model finished with a non-"stop" reason
 * (truncation/`length`, content filter, an `unknown`/`other` gateway finish)
 * resolves with no output object. The AI SDK's `experimental_output` getter then
 * throws NoOutputGeneratedError ("No output generated."). readStructuredOutput must
 * swallow exactly that error (→ undefined, so the caller falls through to the
 * tolerant retry) while passing real output through and re-throwing anything else.
 */
describe('readStructuredOutput', () => {
  it('passes a produced output object straight through', () => {
    const r = { experimental_output: { answer: 42 } };
    expect(readStructuredOutput(r)).toEqual({ answer: 42 });
  });

  it('returns undefined when the getter throws NoOutputGeneratedError', () => {
    const r = {
      get experimental_output(): unknown {
        throw new NoOutputGeneratedError();
      },
    };
    expect(readStructuredOutput(r)).toBeUndefined();
  });

  it('re-throws any other getter error (e.g. a genuine upstream failure)', () => {
    const boom = new Error('connection reset');
    const r = {
      get experimental_output(): unknown {
        throw boom;
      },
    };
    expect(() => readStructuredOutput(r)).toThrow(boom);
  });

  it('does NOT swallow NoObjectGeneratedError — that is a distinct, separately-handled class', () => {
    const noObject = new NoObjectGeneratedError({
      message: 'No object generated.',
      text: '',
      response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } as LanguageModelUsage,
      finishReason: 'stop',
    });
    const r = {
      get experimental_output(): unknown {
        throw noObject;
      },
    };
    expect(() => readStructuredOutput(r)).toThrow(noObject);
  });
});
