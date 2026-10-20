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

  it('charges error rows that carry a cost: the cap never filters on status or error', async () => {
    // Billed but unusable Clef/Clairic 2xx responses (U1), and transcriptions whose processor
    // failed after paid speech-to-text, are recorded as error rows WITH a cost: client spend.
    // tests/cli-management.integration.test.ts checks the same rule against real PostgreSQL.
    const execute = vi.fn().mockResolvedValue({ rows: [{ used: '0' }] });
    mocks.getDb.mockReturnValue({ execute });

    await costUsedThisMonth('00000000-0000-4000-8000-000000000003');

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).not.toMatch(/\bstatus\b/i);
    expect(query.sql).not.toMatch(/\berror_message\b/i);
  });
});
