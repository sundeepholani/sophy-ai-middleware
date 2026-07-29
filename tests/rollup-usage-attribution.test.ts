import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('@/lib/files/blob', () => ({ sweepStaleUploads: vi.fn() }));
vi.mock('@/lib/eval/process', () => ({ processEvalRuns: vi.fn() }));
vi.mock('@/lib/kb/ingest', () => ({ processKbIngestion: vi.fn() }));

import { rollupRecentDays } from '@/app/api/cron/rollup/route';

afterEach(() => {
  vi.clearAllMocks();
});

describe('daily client rollup attribution', () => {
  it('counts only proxy requests while summing both STT pipeline components', async () => {
    let selected: Record<string, unknown> = {};
    let whereCondition: unknown;
    mocks.getDb.mockReturnValue({
      select: vi.fn((fields: Record<string, unknown>) => {
        selected = fields;
        return {
          from: vi.fn(() => ({
            where: vi.fn((condition: unknown) => {
              whereCondition = condition;
              return {
                groupBy: vi.fn().mockResolvedValue([]),
              };
            }),
          })),
        };
      }),
    });

    await expect(rollupRecentDays()).resolves.toBe(0);

    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(selected.requests as SQL).sql).toContain("source\" = 'proxy'");
    expect(dialect.sqlToQuery(selected.inputTokens as SQL).sql).not.toContain('source');
    expect(dialect.sqlToQuery(selected.outputTokens as SQL).sql).not.toContain('source');
    expect(dialect.sqlToQuery(selected.cost as SQL).sql).not.toContain('source');
    expect(dialect.sqlToQuery(selected.errors as SQL).sql).toContain("source\" = 'proxy'");
    const whereParams = dialect.sqlToQuery(whereCondition as SQL).params;
    expect(whereParams.slice(1)).toEqual(['proxy', 'transcript_processor']);
  });
});
