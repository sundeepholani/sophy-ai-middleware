import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('@vercel/blob', () => ({ put: mocks.put, del: mocks.del }));
vi.mock('@/lib/env', () => ({
  env: { blobReadWriteToken: () => 'test-blob-token' },
}));

import {
  assertOwnedBlobs,
  extractModelImageUrls,
  sweepStaleUploads,
  uploadClientFile,
  uploadKbDocument,
} from '@/lib/files/blob';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const KEY_ID = '00000000-0000-4000-8000-000000000003';
const OTHER_KEY_ID = '00000000-0000-4000-8000-000000000004';
const KB_ID = '00000000-0000-4000-8000-000000000005';
const UPLOAD_URL = `https://store.public.blob.vercel-storage.com/uploads/${PROJECT_ID}/${KEY_ID}/invoice.pdf`;

function mockOwnershipRows(
  rows: Array<{ url: string; projectId: string; apiKeyId: string }>,
) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  mocks.getDb.mockReturnValue({ select });
  return { select, from, where };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('project-scoped Blob ownership', () => {
  it('allows only a managed upload row owned by the exact project and key', async () => {
    mockOwnershipRows([{ url: UPLOAD_URL, projectId: PROJECT_ID, apiKeyId: KEY_ID }]);
    await expect(assertOwnedBlobs(PROJECT_ID, KEY_ID, [UPLOAD_URL])).resolves.toBe(true);

    mockOwnershipRows([{ url: UPLOAD_URL, projectId: OTHER_PROJECT_ID, apiKeyId: KEY_ID }]);
    await expect(assertOwnedBlobs(PROJECT_ID, KEY_ID, [UPLOAD_URL])).resolves.toBe(false);

    mockOwnershipRows([{ url: UPLOAD_URL, projectId: PROJECT_ID, apiKeyId: OTHER_KEY_ID }]);
    await expect(assertOwnedBlobs(PROJECT_ID, KEY_ID, [UPLOAD_URL])).resolves.toBe(false);
  });

  it('fails closed for unregistered uploads and admin-only KB source paths', async () => {
    mockOwnershipRows([]);
    await expect(assertOwnedBlobs(PROJECT_ID, KEY_ID, [UPLOAD_URL])).resolves.toBe(false);

    mockOwnershipRows([]);
    const kbUrl = `https://store.public.blob.vercel-storage.com/kb/${PROJECT_ID}/${KB_ID}/source.pdf`;
    await expect(assertOwnedBlobs(PROJECT_ID, KEY_ID, [kbUrl])).resolves.toBe(false);
  });

  it('recognizes an encoded managed prefix but ignores external and deceptive hosts', async () => {
    mockOwnershipRows([]);
    const encoded = `https://store.public.blob.vercel-storage.com/%75ploads/${PROJECT_ID}/${KEY_ID}/file.pdf`;
    await expect(assertOwnedBlobs(PROJECT_ID, KEY_ID, [encoded])).resolves.toBe(false);
    const malformedRemainder =
      'https://store.public.blob.vercel-storage.com/uploads/%E0%A4%A/file.pdf';
    await expect(assertOwnedBlobs(PROJECT_ID, KEY_ID, [malformedRemainder])).resolves.toBe(false);
    expect(mocks.getDb).toHaveBeenCalledTimes(2);

    mocks.getDb.mockClear();
    await expect(
      assertOwnedBlobs(PROJECT_ID, KEY_ID, [
        'https://example.com/uploads/project/key/file.pdf',
        'https://store.public.blob.vercel-storage.com/public/file.pdf',
        'https://store.public.blob.vercel-storage.com.attacker.example/uploads/project/key/file.pdf',
      ]),
    ).resolves.toBe(true);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it('writes client uploads into a project + key namespace and persists projectId', async () => {
    mocks.put.mockResolvedValue({ pathname: 'stored-path', url: 'https://blob.example/stored' });
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockReturnValue({ insert: vi.fn(() => ({ values })) });

    await uploadClientFile({
      projectId: PROJECT_ID,
      keyId: KEY_ID,
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      data: new ArrayBuffer(8),
    });

    expect(mocks.put).toHaveBeenCalledWith(
      `uploads/${PROJECT_ID}/${KEY_ID}/invoice.pdf`,
      expect.any(ArrayBuffer),
      expect.objectContaining({ token: 'test-blob-token' }),
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, apiKeyId: KEY_ID }),
    );
  });

  it('writes KB documents into a project + KB namespace and persists projectId', async () => {
    mocks.put.mockResolvedValue({ pathname: 'stored-path', url: 'https://blob.example/stored' });
    const returning = vi.fn().mockResolvedValue([{ id: 'document-id' }]);
    const values = vi.fn(() => ({ returning }));
    mocks.getDb.mockReturnValue({ insert: vi.fn(() => ({ values })) });

    await uploadKbDocument({
      projectId: PROJECT_ID,
      kbId: KB_ID,
      filename: 'source.pdf',
      contentType: 'application/pdf',
      data: new ArrayBuffer(8),
    });

    expect(mocks.put).toHaveBeenCalledWith(
      `kb/${PROJECT_ID}/${KB_ID}/source.pdf`,
      expect.any(ArrayBuffer),
      expect.objectContaining({ token: 'test-blob-token' }),
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, kbId: KB_ID }),
    );
  });

  it('locks and extends an owned image before it can be used by a logged request', async () => {
    const row = { url: UPLOAD_URL, projectId: PROJECT_ID, apiKeyId: KEY_ID };
    const lock = vi.fn().mockResolvedValue([row]);
    const selectWhere = vi.fn(() => ({ for: lock }));
    const from = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from }));
    const updateWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
    const set = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set }));
    const tx = { select, update };
    const transaction = vi.fn(async (fn: (value: typeof tx) => Promise<boolean>) => fn(tx));
    mocks.getDb.mockReturnValue({ transaction });
    const retainUntil = new Date('2026-08-10T00:00:00Z');

    await expect(
      assertOwnedBlobs(PROJECT_ID, KEY_ID, [UPLOAD_URL], {
        retainImageUrls: [UPLOAD_URL],
        retainUntil,
      }),
    ).resolves.toBe(true);

    expect(lock).toHaveBeenCalledWith('update');
    expect(set).toHaveBeenCalledWith({ expiresAt: retainUntil });
    expect(updateWhere).toHaveBeenCalledOnce();
  });

  it('extracts only image values actually forwarded to the model', () => {
    expect(
      extractModelImageUrls([
        {
          role: 'user',
          content: [
            { type: 'image', image: new URL(UPLOAD_URL) },
            { type: 'file', data: new URL(`${UPLOAD_URL}.pdf`), mediaType: 'application/pdf' },
            { type: 'text', text: 'inspect' },
          ],
        },
      ]),
    ).toEqual([UPLOAD_URL]);
  });
});

describe('upload retention cleanup', () => {
  function mockExpiredUploads() {
    const stale = [{ pathname: 'uploads/project/key/image.png', url: UPLOAD_URL }];
    const lock = vi.fn().mockResolvedValue(stale);
    const limit = vi.fn(() => ({ for: lock }));
    const selectWhere = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from }));
    const deleteWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
    const deleteRow = vi.fn(() => ({ where: deleteWhere }));
    const tx = { select, delete: deleteRow };
    const transaction = vi.fn(async (fn: (value: typeof tx) => Promise<number>) => fn(tx));
    mocks.getDb.mockReturnValue({ transaction });
    return { deleteRow, deleteWhere, selectWhere, transaction, lock };
  }

  it('deletes expired objects and then their metadata', async () => {
    const db = mockExpiredUploads();
    mocks.del.mockResolvedValue(undefined);

    await expect(sweepStaleUploads(new Date('2026-08-03T00:00:00Z'))).resolves.toBe(1);
    expect(mocks.del).toHaveBeenCalledWith([UPLOAD_URL], { token: 'test-blob-token' });
    expect(db.lock).toHaveBeenCalledWith('update', { skipLocked: true });
    expect(db.deleteRow).toHaveBeenCalledOnce();
    expect(db.deleteWhere).toHaveBeenCalledOnce();
  });

  it('retains metadata for a later retry when object deletion fails', async () => {
    const db = mockExpiredUploads();
    mocks.del.mockRejectedValue(new Error('temporary Blob failure'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(sweepStaleUploads(new Date('2026-08-03T00:00:00Z'))).resolves.toBe(0);
    expect(db.deleteRow).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[blob] del failed; retaining metadata for retry');
    error.mockRestore();
  });
});
