import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Every surface guard classifies a key's model through the shared
 * catalogCapability (lib/gateway/models.ts). These run the REAL lookup — fetch
 * is stubbed, the modules are not — so a guard that drifts back to a private
 * copy of the lookup loses the 1.5s bound and fails the last case.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const CATALOG = [
  { id: 'openai/gpt-5-mini', type: 'language' },
  { id: 'openai/text-embedding-3-small', type: 'embedding' },
  { id: 'openai/gpt-image-1', type: 'image' },
  { id: 'typesafe-ai/jev', type: 'evaluation' },
];

function stubCatalog() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: CATALOG }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

type Guard = (model: string) => Promise<string>;

const SURFACES: {
  name: string;
  load: () => Promise<Guard>;
  own: string;
  other: string;
  yes: string;
  no: string;
}[] = [
  {
    name: 'embeddings',
    load: async () => (await import('@/lib/gateway/embeddings')).embeddingCapability,
    own: 'openai/text-embedding-3-small',
    other: 'openai/gpt-5-mini',
    yes: 'embedding',
    no: 'not_embedding',
  },
  {
    name: 'images',
    load: async () => (await import('@/lib/gateway/images')).imageCapability,
    own: 'openai/gpt-image-1',
    other: 'openai/text-embedding-3-small',
    yes: 'image',
    no: 'not_image',
  },
  {
    name: 'assessments',
    load: async () => (await import('@/lib/gateway/assessments')).assessmentCapability,
    own: 'typesafe-ai/jev',
    other: 'openai/gpt-5-mini',
    yes: 'assessment',
    no: 'not_assessment',
  },
];

for (const s of SURFACES) {
  describe(`${s.name} capability guard`, () => {
    it('classifies a catalogued model of its own type', async () => {
      vi.resetModules();
      stubCatalog();
      await expect((await s.load())(s.own)).resolves.toBe(s.yes);
    });

    it('rejects a catalogued model of another type', async () => {
      vi.resetModules();
      stubCatalog();
      await expect((await s.load())(s.other)).resolves.toBe(s.no);
    });

    it("fails open to 'unknown' for an uncatalogued id", async () => {
      vi.resetModules();
      stubCatalog();
      await expect((await s.load())('private/custom-model')).resolves.toBe('unknown');
    });

    it("gives up with 'unknown' at the shared 1.5s bound, not fetchFresh's 10s", async () => {
      vi.resetModules();
      // A catalog request that never settles.
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
      const guard = await s.load();

      vi.useFakeTimers();
      const verdict = guard(s.own);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(verdict).resolves.toBe('unknown');
    });
  });
}
