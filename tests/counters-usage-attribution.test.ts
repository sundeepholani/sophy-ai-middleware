import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));

import { costUsedThisMonth } from '@/lib/counters';

afterEach(() => {
  vi.clearAllMocks();
});

describe('monthly client budget attribution', () => {
  it('charges both STT and transcript processing while excluding Sophy eval/KB spend', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ used: '12.34' }] });
    mocks.getDb.mockReturnValue({ execute });

    await expect(costUsedThisMonth('00000000-0000-4000-8000-000000000003')).resolves.toBe(
      12.34,
    );

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain("source IN ('proxy', 'transcript_processor')");
    expect(query.sql).not.toContain('eval_challenger');
    expect(query.sql).not.toContain('kb_query');
  });
});
