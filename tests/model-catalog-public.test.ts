import { afterEach, describe, expect, it, vi } from 'vitest';
import { listAllModels } from '@/lib/gateway/models';

afterEach(() => vi.unstubAllGlobals());

describe('public gateway model catalog', () => {
  it('never sends a project or platform Authorization header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has('authorization')).toBe(false);
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-5-mini',
              name: 'GPT-5 mini',
              owned_by: 'openai',
              type: 'language',
              tags: [],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAllModels()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
