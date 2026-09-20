import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The chat and responses surfaces now consult the catalog on every request, so
 * these guard the properties that keeps that affordable: one fetch per cold
 * instance regardless of concurrency, and a backoff so a degraded gateway is
 * not re-attempted by every in-flight request.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function payload() {
  return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-5-mini', type: 'language' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchCatalog', () => {
  it('collapses concurrent cold callers onto a single fetch', async () => {
    vi.resetModules();
    let resolveFetch: (r: Response) => void = () => {};
    const gate = new Promise<Response>((r) => {
      resolveFetch = r;
    });
    const fetchMock = vi.fn(() => gate);
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('@/lib/gateway/models');
    const all = Promise.all(Array.from({ length: 50 }, () => mod.listAllModels()));
    resolveFetch(payload());
    const results = await all;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(50);
    expect(results.every((r) => r.length === 1)).toBe(true);
  });

  it('serves the memo without re-fetching inside the TTL', async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () => payload());
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('@/lib/gateway/models');
    await mod.listAllModels();
    await mod.listAllModels();
    await mod.listAllModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves the last good copy when a refresh fails', async () => {
    vi.resetModules();
    let fail = false;
    const fetchMock = vi.fn(async () => {
      if (fail) throw new Error('gateway down');
      return payload();
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('@/lib/gateway/models');
    await mod.listAllModels();

    // Expire the memo, then break the endpoint.
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    fail = true;
    await expect(mod.listAllModels()).resolves.toHaveLength(1);
  });

  it('backs off after a failure instead of re-attempting on every request', async () => {
    vi.resetModules();
    let fail = false;
    const fetchMock = vi.fn(async () => {
      if (fail) throw new Error('gateway down');
      return payload();
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('@/lib/gateway/models');
    await mod.listAllModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    fail = true;
    await mod.listAllModels(); // one failed attempt, serves stale
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Without the backoff stamp these would each re-attempt behind a 10s timeout.
    await mod.listAllModels();
    await mod.listAllModels();
    await mod.listAllModels();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still throws on a cold failure with no stale copy, so guards read it as unknown', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('gateway down');
      }),
    );
    const mod = await import('@/lib/gateway/models');
    await expect(mod.listAllModels()).rejects.toThrow();
    // The classifier converts that throw into a fail-open verdict.
    await expect(mod.languageCapability('openai/gpt-5-mini')).resolves.toBe('unknown');
  });
});
