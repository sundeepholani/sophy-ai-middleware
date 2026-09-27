import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(), listKeys: vi.fn(), getRecentLogs: vi.fn(), keyFilter: vi.fn(),
}));

vi.mock('@/lib/auth/viewer', () => ({ requireProjectViewer: mocks.viewer }));
vi.mock('@/lib/admin/queries', () => ({ listKeys: mocks.listKeys, getRecentLogs: mocks.getRecentLogs }));
vi.mock('@/components/admin/logs-table', () => ({ LogsTable: () => null }));
vi.mock('@/components/admin/logs-key-filter', () => ({
  LogsKeyFilter: (props: unknown) => { mocks.keyFilter(props); return null; },
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children),
}));

import LogsPage from '@/app/admin/p/[projectId]/logs/page';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const KEY = '00000000-0000-4000-8000-000000000002';
const HIDDEN = '00000000-0000-4000-8000-000000000003';
const VIEWER = { userId: HIDDEN, projectId: PROJECT, projectName: 'Project', role: 'editor' };

async function render(searchParams: { source?: string; key?: string }) {
  const page = await LogsPage({ params: Promise.resolve({ projectId: PROJECT }), searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(page);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.viewer.mockResolvedValue(VIEWER);
  mocks.listKeys.mockResolvedValue([{ id: KEY, name: 'Support' }]);
  mocks.getRecentLogs.mockResolvedValue([]);
});

describe('console logs key filter', () => {
  it('loads the 100 newest logs for a visible key and keeps it across source tabs', async () => {
    const html = await render({ key: KEY, source: 'proxy' });
    expect(mocks.getRecentLogs).toHaveBeenCalledWith(VIEWER, 100, 'proxy', KEY);
    expect(mocks.keyFilter).toHaveBeenCalledWith({ keys: [{ id: KEY, name: 'Support' }], current: KEY });
    const base = `/admin/p/${PROJECT}/logs`;
    expect(html).toContain(`href="${base}?key=${KEY}"`);
    expect(html).toContain(`href="${base}?source=judge&amp;key=${KEY}"`);
  });

  it.each([HIDDEN, 'not-a-uuid'])('ignores a key outside the viewer’s list (%s)', async (key) => {
    const html = await render({ key });
    // An unvalidated value never reaches the SQL, where a non-UUID would 500.
    expect(mocks.getRecentLogs).toHaveBeenCalledWith(VIEWER, 100, undefined, undefined);
    expect(mocks.keyFilter).toHaveBeenCalledWith(expect.objectContaining({ current: 'all' }));
    expect(html).toContain(`href="/admin/p/${PROJECT}/logs"`);
    expect(html).not.toContain(key);
  });
});
