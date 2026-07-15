import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayAuthenticationError } from '@ai-sdk/gateway';
import { APICallError } from 'ai';
import {
  createExplicitGateway,
  projectCredentialFailure,
  projectGatewayUnavailableResponse,
  ProjectGatewayUnavailableError,
  validateGatewayCredential,
} from '@/lib/gateway/project-provider';
import { commonCall, type CallContext } from '@/lib/gateway/call';

function apiError(statusCode: number) {
  return new APICallError({
    message: 'sensitive upstream detail',
    url: 'https://gateway.example/v1',
    requestBodyValues: {},
    statusCode,
    responseBody: 'sensitive upstream detail',
    isRetryable: false,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('project gateway provider invariants', () => {
  it('rejects empty credentials before the SDK can fall back to OIDC or env', () => {
    expect(() => createExplicitGateway('   ')).toThrow(/must not be empty/);
  });

  it('creates explicit language, embedding, and image handles', () => {
    const gateway = createExplicitGateway('explicit-test-key');
    expect(gateway.languageModel('openai/gpt-5-mini').modelId).toBe('openai/gpt-5-mini');
    expect(gateway.embeddingModel('openai/text-embedding-3-small').modelId).toBe(
      'openai/text-embedding-3-small',
    );
    expect(gateway.imageModel('openai/gpt-image-1').modelId).toBe('openai/gpt-image-1');
  });

  it('validates a candidate with authenticated getCredits', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/credits');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer explicit-test-key');
      return new Response(JSON.stringify({ balance: '10.00', total_used: '2.50' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(validateGatewayCredential('explicit-test-key')).resolves.toMatchObject({
      balance: '10.00',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('puts an explicit provider model object on the shared generation call', () => {
    const gateway = createExplicitGateway('explicit-test-key');
    const snapshot = Object.freeze({
      projectId: '00000000-0000-4000-8000-000000000001',
      gatewayCredentialId: '00000000-0000-4000-8000-000000000002',
      credentialRevision: 1,
      source: 'encrypted_api_key' as const,
      gateway,
    });
    const ctx: CallContext = {
      gateway: snapshot,
      keyId: '00000000-0000-4000-8000-000000000003',
      model: 'openai/gpt-5-mini',
      systemPrompt: null,
      params: {},
      structured: false,
      schema: null,
      includeUsage: false,
      logContent: false,
    };
    const call = commonCall(ctx, []);
    expect(typeof call.model).toBe('object');
    expect(call.model.modelId).toBe(ctx.model);
  });

  it('classifies only credential auth and billing failures as project outages', () => {
    expect(projectCredentialFailure(new GatewayAuthenticationError())).toBe('invalid');
    expect(projectCredentialFailure(apiError(402))).toBe('billing_attention');
    expect(projectCredentialFailure(apiError(429))).toBeNull();
    expect(projectCredentialFailure({ cause: apiError(401) })).toBe('invalid');
    expect(projectCredentialFailure(Object.assign(new Error('wrapped'), { name: 'GatewayError' }))).toBe(
      'invalid',
    );
    expect(
      projectCredentialFailure(
        Object.assign(new Error('wrapped'), { name: 'GatewayAuthenticationError' }),
      ),
    ).toBe('invalid');
  });

  it('returns the typed OpenAI-compatible 503 without exposing its cause', async () => {
    const error = new ProjectGatewayUnavailableError(
      '00000000-0000-4000-8000-000000000001',
      'credential_invalid',
      '00000000-0000-4000-8000-000000000002',
      new Error('secret account detail'),
    );
    const response = projectGatewayUnavailableResponse(error);
    expect(response?.status).toBe(503);
    const body = await response?.json();
    expect(body.error.code).toBe('project_gateway_unavailable');
    expect(body.error.message).not.toContain('secret account detail');
  });
});
