import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import proxy from '@/proxy';
import { safeNextPath } from '@/lib/auth/safe-next';

beforeAll(() => {
  vi.stubEnv('SESSION_PASSWORD', 'synthetic-session-password-for-proxy-tests');
});

async function signInRedirect(path: string) {
  const response = await proxy(new NextRequest(`https://sophy.test${path}`));
  expect(response.status).toBe(307);
  return new URL(response.headers.get('location')!);
}

describe('signed-out console requests', () => {
  it('return to the full requested URL, query included, after sign-in', async () => {
    const target = '/admin/p/project-1/logs?source=proxy&key=00000000-0000-4000-8000-000000000002';
    const login = await signInRedirect(target);
    expect(login.origin).toBe('https://sophy.test');
    expect(login.pathname).toBe('/admin/login');
    // The original filters travel only inside `next`, not beside it.
    expect([...login.searchParams.keys()]).toEqual(['next']);
    expect(login.searchParams.get('next')).toBe(target);
    // What the verify route hands back to the login page for navigation.
    expect(safeNextPath(login.searchParams.get('next'))).toBe(target);
  });

  it('keep encoded query values intact through the round trip', async () => {
    const target = '/admin/p/project-1/usage?model=vendor%2Fmodel&range=7';
    const login = await signInRedirect(target);
    expect(safeNextPath(login.searchParams.get('next'))).toBe(target);
  });

  it('use the bare path when there is no query', async () => {
    const login = await signInRedirect('/admin/p/project-1/keys');
    expect(login.search).toBe(`?next=${encodeURIComponent('/admin/p/project-1/keys')}`);
  });

  it('leave API requests as a 401, not a redirect', async () => {
    const response = await proxy(new NextRequest('https://sophy.test/api/admin/logout'));
    expect(response.status).toBe(401);
  });
});
