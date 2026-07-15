import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  assertProjectAdmin: vi.fn(),
  revalidatePath: vi.fn(),
  uploadKbDocument: vi.fn(),
  deleteBlobObjects: vi.fn(),
  isKbContentTypeAllowed: vi.fn(),
  listKbDocuments: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('@/lib/auth/viewer', () => ({ assertProjectAdmin: mocks.assertProjectAdmin }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/files/blob', () => ({
  uploadKbDocument: mocks.uploadKbDocument,
  deleteBlobObjects: mocks.deleteBlobObjects,
  MAX_UPLOAD_BYTES: 4 * 1024 * 1024,
}));
vi.mock('@/lib/kb/extract', () => ({
  isKbContentTypeAllowed: mocks.isKbContentTypeAllowed,
}));
vi.mock('@/lib/admin/queries', () => ({
  listKbDocuments: mocks.listKbDocuments,
}));

import {
  createKnowledgebase,
  deleteKbDocument,
  listKbDocumentsAction,
  uploadKbDocumentAction,
} from '@/app/admin/kb-actions';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const KB_ID = '00000000-0000-4000-8000-000000000003';
const DOC_ID = '00000000-0000-4000-8000-000000000004';
const VIEWER = {
  userId: '00000000-0000-4000-8000-000000000005',
  email: 'admin@example.com',
  role: 'admin',
  projectId: PROJECT_ID,
  projectName: 'Project',
  projectSlug: 'project',
  projectStatus: 'active',
  defaultProjectId: PROJECT_ID,
};

function selectionDb(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, select, from, where, limit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertProjectAdmin.mockResolvedValue(VIEWER);
  mocks.isKbContentTypeAllowed.mockReturnValue(true);
  mocks.listKbDocuments.mockResolvedValue([]);
  mocks.uploadKbDocument.mockResolvedValue({});
});

describe('project-scoped KB admin actions', () => {
  it('authorizes the project, verifies the KB, and passes the viewer to document reads', async () => {
    const selected = selectionDb([{ id: KB_ID, projectId: PROJECT_ID }]);
    mocks.getDb.mockReturnValue(selected.db);
    const documents = [{ id: DOC_ID }];
    mocks.listKbDocuments.mockResolvedValue(documents);

    await expect(
      listKbDocumentsAction({ projectId: PROJECT_ID, kbId: KB_ID }),
    ).resolves.toBe(documents);
    expect(mocks.assertProjectAdmin).toHaveBeenCalledWith(PROJECT_ID);
    expect(mocks.listKbDocuments).toHaveBeenCalledWith(VIEWER, KB_ID);
  });

  it('rejects a KB row from another project before reading its documents', async () => {
    const selected = selectionDb([{ id: KB_ID, projectId: OTHER_PROJECT_ID }]);
    mocks.getDb.mockReturnValue(selected.db);

    await expect(
      listKbDocumentsAction({ projectId: PROJECT_ID, kbId: KB_ID }),
    ).rejects.toThrow('Knowledgebase not found');
    expect(mocks.listKbDocuments).not.toHaveBeenCalled();
  });

  it('persists projectId on the KB and its audit row, then revalidates the project route', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: KB_ID }]);
    const kbValues = vi.fn(() => ({ returning }));
    const auditValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi
      .fn()
      .mockImplementationOnce(() => ({ values: kbValues }))
      .mockImplementationOnce(() => ({ values: auditValues }));
    mocks.getDb.mockReturnValue({ insert });

    await expect(
      createKnowledgebase({ projectId: PROJECT_ID, name: ' Product docs ' }),
    ).resolves.toEqual({ id: KB_ID });
    expect(kbValues).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, name: 'Product docs' }),
    );
    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, action: 'kb.create', target: KB_ID }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/admin/p/${PROJECT_ID}/knowledgebases`,
    );
  });

  it('uploads only after project-admin and KB ownership checks', async () => {
    const selected = selectionDb([{ id: KB_ID, projectId: PROJECT_ID }]);
    const auditValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values: auditValues }));
    mocks.getDb.mockReturnValue({ ...selected.db, insert });
    const file = new File(['# Guide'], 'guide.md', { type: '' });
    const formData = new FormData();
    formData.set('projectId', PROJECT_ID);
    formData.set('kbId', KB_ID);
    formData.set('file', file);

    await expect(uploadKbDocumentAction(formData)).resolves.toEqual({ filename: 'guide.md' });
    expect(mocks.assertProjectAdmin).toHaveBeenCalledWith(PROJECT_ID);
    expect(mocks.uploadKbDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        kbId: KB_ID,
        filename: 'guide.md',
        contentType: 'text/markdown',
      }),
    );
    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, action: 'kb.document.upload' }),
    );
  });

  it('does not delete a document returned from another project', async () => {
    const selected = selectionDb([
      {
        id: DOC_ID,
        projectId: OTHER_PROJECT_ID,
        kbId: KB_ID,
        url: 'https://store.public.blob.vercel-storage.com/kb/other/source.pdf',
      },
    ]);
    mocks.getDb.mockReturnValue(selected.db);

    await expect(deleteKbDocument({ projectId: PROJECT_ID, id: DOC_ID })).rejects.toThrow(
      'Document not found',
    );
    expect(mocks.deleteBlobObjects).not.toHaveBeenCalled();
  });
});
