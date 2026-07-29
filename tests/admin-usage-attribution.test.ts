import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Viewer } from '@/lib/auth/viewer';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));

import {
  getOverview,
  getRecentLogs,
  getUsageByModel,
  getUsageBySource,
  getUsageTotals,
} from '@/lib/admin/queries';

const viewer = {
  userId: '00000000-0000-4000-8000-000000000010',
  email: 'admin@example.com',
  role: 'admin',
  projectId: '00000000-0000-4000-8000-000000000001',
  projectName: 'Project',
  projectSlug: 'project',
  projectStatus: 'active',
  defaultProjectId: null,
} satisfies Viewer;

function compiled(value: unknown) {
  return new PgDialect().sqlToQuery(value as SQL);
}

function captureSimpleSelect(rows: unknown[]) {
  let selected: Record<string, unknown> = {};
  mocks.getDb.mockReturnValue({
    select: vi.fn((fields: Record<string, unknown>) => {
      selected = fields;
      return {
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(rows),
        })),
      };
    }),
  });
  return () => selected;
}

function captureGroupedSelect(rows: unknown[]) {
  let selected: Record<string, unknown> = {};
  mocks.getDb.mockReturnValue({
    select: vi.fn((fields: Record<string, unknown>) => {
      selected = fields;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue(rows),
            })),
          })),
        })),
      };
    }),
  });
  return () => selected;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('admin client-usage attribution', () => {
  it('counts one terminal proxy outcome while folding processor tokens and cost into client totals', async () => {
    const selected = captureSimpleSelect([
      {
        requests: '1',
        inputTokens: '20',
        outputTokens: '5',
        cost: '0.006',
        errors: '1',
        shadowCost: '0.010',
      },
    ]);

    await expect(getOverview(viewer)).resolves.toEqual({
      requests: 1,
      inputTokens: 20,
      outputTokens: 5,
      cost: 0.006,
      errors: 1,
      shadowCost: 0.01,
    });

    const fields = selected();
    expect(compiled(fields.requests).sql).toContain("source\" = 'proxy'");
    for (const name of ['inputTokens', 'outputTokens', 'cost'] as const) {
      expect(compiled(fields[name]).params).toEqual(['proxy', 'transcript_processor']);
    }
    expect(compiled(fields.errors).sql).toContain("source\" = 'proxy'");
    const shadow = compiled(fields.shadowCost);
    expect(shadow.sql.toLowerCase()).toContain('not');
    expect(shadow.params).toEqual(['proxy', 'transcript_processor']);
  });

  it('uses the same client-source rule for usage totals and processor model attribution', async () => {
    let selected = captureSimpleSelect([
      { requests: '1', inputTokens: '20', outputTokens: '5', cost: '0.006' },
    ]);
    await expect(getUsageTotals(viewer, { sinceDays: 30 })).resolves.toEqual({
      requests: 1,
      inputTokens: 20,
      outputTokens: 5,
      cost: 0.006,
    });
    expect(compiled(selected().requests).sql).toContain("source\" = 'proxy'");
    expect(compiled(selected().inputTokens).params).toEqual(['proxy', 'transcript_processor']);
    expect(compiled(selected().outputTokens).params).toEqual(['proxy', 'transcript_processor']);

    selected = captureGroupedSelect([
      {
        model: 'anthropic/claude-sonnet-4.5',
        requests: '0',
        inputTokens: '20',
        outputTokens: '5',
        cost: '0.002',
      },
    ]);
    await expect(getUsageByModel(viewer, { sinceDays: 30 })).resolves.toEqual([
      {
        label: 'anthropic/claude-sonnet-4.5',
        requests: 0,
        inputTokens: 20,
        outputTokens: 5,
        cost: 0.002,
      },
    ]);
    expect(compiled(selected().requests).sql).toContain("source\" = 'proxy'");
    expect(compiled(selected().inputTokens).params).toEqual(['proxy', 'transcript_processor']);
  });

  it('shows transcript processing as a zero-request client component in the source card', async () => {
    const selected = captureGroupedSelect([
      {
        source: 'transcript_processor',
        requests: '0',
        inputTokens: '20',
        outputTokens: '5',
        cost: '0.002',
      },
    ]);

    await expect(getUsageBySource(viewer, { sinceDays: 30 })).resolves.toEqual([
      {
        label: 'Client traffic — transcript processing',
        requests: 0,
        inputTokens: 20,
        outputTokens: 5,
        cost: 0.002,
      },
    ]);
    expect(compiled(selected().requests).sql).toContain("<> 'transcript_processor'");
  });

  it('labels a processor usage row as processor rather than a duplicate proxy log', async () => {
    let whereCondition: unknown;
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn((condition: unknown) => {
              whereCondition = condition;
              return {
                orderBy: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue([
                    {
                      id: '00000000-0000-4000-8000-000000000099',
                      createdAt: new Date('2026-07-29T00:00:00Z'),
                      apiKeyId: '00000000-0000-4000-8000-000000000003',
                      keyName: 'STT key',
                      model: 'anthropic/claude-sonnet-4.5',
                      rowSource: 'transcript_processor',
                      inputTokens: 20,
                      outputTokens: 5,
                      costUsd: '0.002000',
                      status: 'ok',
                      streamed: false,
                      responseKind: 'transcription',
                    },
                  ]),
                })),
              };
            }),
          })),
        })),
      })),
    });

    await expect(getRecentLogs(viewer, 100, 'processor')).resolves.toMatchObject([
      {
        source: 'processor',
        model: 'anthropic/claude-sonnet-4.5',
      },
    ]);
    expect(compiled(whereCondition).sql).toContain("source\" = 'transcript_processor'");
  });
});
