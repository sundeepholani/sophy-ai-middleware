import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_MODELS,
  CloudflareModelNotRegisteredError,
  cloudflareAvailableModel,
  cloudflareAvailableModels,
  cloudflareInputTokenEstimate,
  getCloudflareModel,
  isCloudflareModelId,
  requireCloudflareModel,
} from '@/lib/gateway/cloudflare-models';
import { providerOf } from '@/lib/gateway/provider-of';

/**
 * The Cloudflare Workers AI registry is the code-reviewed allowlist (D4, D5):
 * every price, limit and selector is pinned here, so a change to any of them is
 * a deliberate, reviewed edit of this file too.
 */

const DOCS = 'https://developers.cloudflare.com/workers-ai/models';
const IDS = [
  '@cf/cloudflare/clef',
  '@cf/cloudflare/clef-flash',
  '@cf/cloudflare/clef-omni',
  '@cf/cloudflare/clairic',
];

/** 10-foundation.md §A2, every field except the description (checked separately). */
const PINNED = [
  {
    id: '@cf/cloudflare/clef', name: 'Clef', provider: 'cloudflare', type: 'evaluation', selector: 'clef',
    contextWindow: 65536, maxTokens: null, inputPerMTok: 0.24, outputPerMTok: 0,
    tags: ['evaluation', 'vision'], preview: false, sourceUrl: `${DOCS}/clef/`, verifiedAt: '2026-10-20',
  },
  {
    id: '@cf/cloudflare/clef-flash', name: 'Clef Flash', provider: 'cloudflare', type: 'evaluation', selector: 'clef-flash',
    contextWindow: 24576, maxTokens: null, inputPerMTok: 0.038, outputPerMTok: 0,
    tags: ['evaluation', 'vision'], preview: false, sourceUrl: `${DOCS}/clef-flash/`, verifiedAt: '2026-10-20',
  },
  {
    id: '@cf/cloudflare/clef-omni', name: 'Clef Omni', provider: 'cloudflare', type: 'evaluation', selector: 'clef-omni',
    contextWindow: 65536, maxTokens: null, inputPerMTok: 0.15, outputPerMTok: 0,
    tags: ['evaluation', 'vision'], preview: false, sourceUrl: `${DOCS}/clef-omni/`, verifiedAt: '2026-10-20',
  },
  {
    id: '@cf/cloudflare/clairic', name: 'Clairic', provider: 'cloudflare', type: 'extraction', selector: 'clairic',
    contextWindow: 65536, maxTokens: null, inputPerMTok: 0.1, outputPerMTok: 0,
    tags: ['extraction', 'vision'], preview: true, sourceUrl: `${DOCS}/clairic/`, verifiedAt: '2026-10-20',
  },
];

describe('Cloudflare Workers AI model registry', () => {
  it('pins every registry entry', () => {
    expect(CLOUDFLARE_MODELS).toEqual(PINNED.map((m) => ({ ...m, description: expect.any(String) })));

    const [clef, flash, omni, clairic] = CLOUDFLARE_MODELS.map((m) => m.description);
    expect(clef).toMatch(/^Clef is a 27B/);
    expect(flash).toMatch(/^Clef-flash is a fast 9B/);
    expect(omni).toMatch(/^Clef-omni is a multimodal/);
    expect(clairic).toMatch(/^Clairic is a System One-style/);
    // CCR-4: the catalog sentences mention video (and audio); Sophy accepts text and images only (D8).
    expect(clef.endsWith(' Sophy accepts text and images; video is not supported yet.')).toBe(true);
    expect(flash.endsWith(' Sophy accepts text and images; video is not supported yet.')).toBe(true);
    expect(omni.endsWith(' Sophy accepts text and images; audio and video are not supported yet.')).toBe(true);
    expect(clairic.endsWith(' Research preview.')).toBe(true);
  });

  it('is frozen and fail-closed priced', () => {
    expect(Object.isFrozen(CLOUDFLARE_MODELS)).toBe(true);
    for (const m of CLOUDFLARE_MODELS) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(Object.isFrozen(m.tags)).toBe(true);
      expect(Number.isFinite(m.inputPerMTok)).toBe(true);
      expect(m.inputPerMTok).toBeGreaterThan(0);
      expect(m.outputPerMTok).toBe(0);
      expect(m.maxTokens).toBeNull();
      expect(m.id).toBe(`@cf/cloudflare/${m.selector}`);
    }
    expect(new Set(CLOUDFLARE_MODELS.map((m) => m.id)).size).toBe(CLOUDFLARE_MODELS.length);
    expect(CLOUDFLARE_MODELS.filter((m) => m.preview).map((m) => m.id)).toEqual(['@cf/cloudflare/clairic']);
  });

  it('isCloudflareModelId is a prefix test', () => {
    for (const id of [...IDS, '@cf/meta/llama-3']) expect(isCloudflareModelId(id)).toBe(true);
    for (const id of ['@CF/cloudflare/clef', ' @cf/cloudflare/clef', 'cloudflare/clef', '', 'typesafe-ai/jev']) {
      expect(isCloudflareModelId(id)).toBe(false);
    }
  });

  it('getCloudflareModel is exact', () => {
    for (const [i, id] of IDS.entries()) expect(getCloudflareModel(id)).toBe(CLOUDFLARE_MODELS[i]);
    for (const id of [
      '@cf/cloudflare/CLEF',
      ' @cf/cloudflare/clef',
      '@cf/cloudflare/clef ',
      '@cf/cloudflare/clef/',
      '@cf/cloudflare/../clef',
      '__proto__',
      'constructor',
    ]) {
      expect(getCloudflareModel(id)).toBeUndefined();
    }
  });

  it('requireCloudflareModel checks registration and type', () => {
    expect(requireCloudflareModel('@cf/cloudflare/clef', 'evaluation')).toBe(CLOUDFLARE_MODELS[0]);

    let error: unknown;
    try {
      requireCloudflareModel('@cf/cloudflare/clairic', 'evaluation');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CloudflareModelNotRegisteredError);
    const notRegistered = error as CloudflareModelNotRegisteredError;
    expect(notRegistered.name).toBe('CloudflareModelNotRegisteredError');
    expect(notRegistered.message).toBe('Not a registered Cloudflare Workers AI evaluation model.');
    expect(notRegistered.model).toBe('@cf/cloudflare/clairic');
    expect(notRegistered.expectedType).toBe('evaluation');

    expect(() => requireCloudflareModel('@cf/cloudflare/clef', 'extraction')).toThrow(
      CloudflareModelNotRegisteredError,
    );
    expect(() => requireCloudflareModel('@cf/x/y', 'evaluation')).toThrow(CloudflareModelNotRegisteredError);
  });

  it('builds fresh catalog rows', () => {
    const clef = CLOUDFLARE_MODELS[0];
    const row = cloudflareAvailableModel(clef);
    expect(row).toEqual({
      id: '@cf/cloudflare/clef',
      name: 'Clef',
      provider: 'cloudflare',
      type: 'evaluation',
      contextWindow: 65536,
      maxTokens: null,
      inputPerMTok: 0.24,
      outputPerMTok: 0,
      description: clef.description,
      tags: ['evaluation', 'vision'],
      preview: false,
    });
    row.tags.push('mutated');
    expect(clef.tags).toEqual(['evaluation', 'vision']);
    expect(cloudflareAvailableModel(clef).tags).toEqual(['evaluation', 'vision']);

    const first = cloudflareAvailableModels();
    const second = cloudflareAvailableModels();
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(4);
    expect(first.map((m) => m.id)).toEqual(IDS);
  });

  it("estimates input tokens like Cloudflare's pre-check", () => {
    // '{"model":"clef-flash","state":"abcd"}' is 37 characters → ceil(37 / 4).
    expect(cloudflareInputTokenEstimate({ model: 'clef-flash', state: 'abcd' })).toBe(10);
    expect(cloudflareInputTokenEstimate(undefined)).toBe(0);
    expect(cloudflareInputTokenEstimate({ state: 'x'.repeat(98_304) })).toBeGreaterThan(24576);
  });

  it('providerOf maps @cf/ ids to cloudflare and leaves the rest unchanged', () => {
    expect(providerOf('@cf/cloudflare/clef')).toBe('cloudflare');
    expect(providerOf('@cf/meta/llama')).toBe('cloudflare');
    expect(providerOf('openai/gpt-5-mini')).toBe('openai');
    expect(providerOf('typesafe-ai/jev')).toBe('typesafe-ai');
    expect(providerOf('plain')).toBe('plain');
    expect(providerOf('')).toBe('');
    expect(providerOf('@cfx/y')).toBe('@cfx');
  });

  it('call.ts re-exports the same providerOf', async () => {
    expect((await import('@/lib/gateway/call')).providerOf).toBe(providerOf);
  });
});
