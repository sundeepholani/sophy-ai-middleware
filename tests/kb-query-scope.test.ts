import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Viewer } from '@/lib/auth/viewer';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));

import {
  listKbDocuments,
  listKnowledgebaseOptions,
  listKnowledgebases,
} from '@/lib/admin/queries';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const KB_ID = '00000000-0000-4000-8000-000000000003';

const editor = {
  userId: USER_ID,
  email: 'editor@example.com',
  role: 'editor',
  projectId: PROJECT_ID,
  projectName: 'Project',
  projectSlug: 'project',
  projectStatus: 'active',
  defaultProjectId: PROJECT_ID,
} satisfies Viewer;

function compiled(value: unknown) {
  return new PgDialect().sqlToQuery(value as SQL);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('knowledgebase query ownership', () => {
  it('shows an editor only KBs they own and scopes both count queries to those KBs', async () => {
    const whereConditions: unknown[] = [];
    let selectIndex = 0;
    const kb = {
      id: KB_ID,
      name: 'Editor docs',
      embeddingModel: 'openai/text-embedding-3-small',
      ownerUserId: USER_ID,
      createdAt: new Date('2026-09-03T00:00:00Z'),
    };
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => {
        const index = selectIndex++;
        if (index === 0) {
          return {
            from: vi.fn(() => ({
              where: vi.fn((condition: unknown) => {
                whereConditions.push(condition);
                return { orderBy: vi.fn().mockResolvedValue([kb]) };
              }),
            })),
          };
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn((condition: unknown) => {
              whereConditions.push(condition);
              return { groupBy: vi.fn().mockResolvedValue([]) };
            }),
          })),
        };
      }),
    });

    await expect(listKnowledgebases(editor)).resolves.toEqual([
      { ...kb, documentCount: 0, attachedKeyCount: 0 },
    ]);

    expect(compiled(whereConditions[0]).sql).toContain('"knowledgebases"."owner_user_id"');
    expect(compiled(whereConditions[0]).params).toEqual([PROJECT_ID, USER_ID]);
    expect(compiled(whereConditions[1]).params).toEqual([PROJECT_ID, KB_ID]);
    expect(compiled(whereConditions[2]).params).toEqual([PROJECT_ID, KB_ID]);
  });

  it('defensively owner-scopes an editor document read', async () => {
    let whereCondition: unknown;
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn((condition: unknown) => {
              whereCondition = condition;
              return { orderBy: vi.fn().mockResolvedValue([]) };
            }),
          })),
        })),
      })),
    });

    await expect(listKbDocuments(editor, KB_ID)).resolves.toEqual([]);

    const query = compiled(whereCondition);
    expect(query.sql).toContain('"knowledgebases"."owner_user_id"');
    expect(query.params).toEqual([PROJECT_ID, KB_ID, USER_ID]);
  });

  it('keeps the editor key picker limited to the current project, not only owned KBs', async () => {
    let whereCondition: unknown;
    const options = [
      { id: KB_ID, name: 'Editor docs' },
      { id: '00000000-0000-4000-8000-000000000004', name: 'Shared docs' },
    ];
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((condition: unknown) => {
            whereCondition = condition;
            return { orderBy: vi.fn().mockResolvedValue(options) };
          }),
        })),
      })),
    });

    await expect(listKnowledgebaseOptions(editor)).resolves.toBe(options);
    const query = compiled(whereCondition);
    expect(query.sql).not.toContain('"knowledgebases"."owner_user_id"');
    expect(query.params).toEqual([PROJECT_ID]);
  });
});
