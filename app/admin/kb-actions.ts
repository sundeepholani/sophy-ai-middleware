'use server';

/**
 * Knowledgebase management mutations (admin-only in v1). Creating a KB and
 * uploading documents are admin actions; ingestion (extract → chunk → embed)
 * happens later in the cron. Deletes reclaim the blob storage and cascade to
 * chunks; a KB that's still attached to keys can't be deleted (detach first).
 */
import { revalidatePath } from 'next/cache';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { knowledgebases, kbDocuments, kbChunks, apiKeys, auditLog } from '@/db/schema';
import { assertAdmin } from '@/lib/auth/viewer';
import { uploadKbDocument, deleteBlobObjects, MAX_UPLOAD_BYTES } from '@/lib/files/blob';
import { isKbContentTypeAllowed } from '@/lib/kb/extract';
import { listKbDocuments, type KbDocumentRow } from '@/lib/admin/queries';

async function audit(actor: string, action: string, target: string, after: unknown): Promise<void> {
  await getDb().insert(auditLog).values({ actor, action, target, after: after as object });
}

/** Best-effort content-type when the browser sends an empty/unknown File.type. */
function inferContentType(filename: string, provided: string): string {
  const t = (provided || '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (t) return t;
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const byExt: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return byExt[ext] ?? '';
}

/** Documents in a KB — called by the manage dialog on open (admin-only). */
export async function listKbDocumentsAction(kbId: string): Promise<KbDocumentRow[]> {
  await assertAdmin();
  return listKbDocuments(kbId);
}

export async function createKnowledgebase(input: { name: string }): Promise<{ id: string }> {
  const viewer = await assertAdmin();
  const name = input.name.trim();
  if (!name) throw new Error('Name is required');
  if (name.length > 200) throw new Error('Name is too long');

  const [row] = await getDb()
    .insert(knowledgebases)
    // embeddingModel uses the column default (openai/text-embedding-3-small);
    // the vector column dimension is locked to it, so it isn't operator-chosen in v1.
    .values({ name, ownerUserId: viewer.userId })
    .returning({ id: knowledgebases.id });

  await audit(viewer.email, 'kb.create', row.id, { name });
  revalidatePath('/admin/knowledgebases');
  return { id: row.id };
}

export async function uploadKbDocumentAction(
  formData: FormData,
): Promise<{ filename: string }> {
  const viewer = await assertAdmin();
  const kbId = String(formData.get('kbId') ?? '');
  const file = formData.get('file');
  if (!kbId) throw new Error('Missing knowledgebase');
  if (!(file instanceof File) || file.size === 0) throw new Error('Choose a file to upload');

  const [kb] = await getDb()
    .select({ id: knowledgebases.id })
    .from(knowledgebases)
    .where(eq(knowledgebases.id, kbId))
    .limit(1);
  if (!kb) throw new Error('Knowledgebase not found');

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is too large (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB)`);
  }
  const contentType = inferContentType(file.name, file.type);
  if (!isKbContentTypeAllowed(contentType)) {
    throw new Error('Unsupported file type — upload text, Markdown, CSV, JSON, PDF, or Word (.docx)');
  }

  const data = await file.arrayBuffer();
  await uploadKbDocument({ kbId, filename: file.name, contentType, data });
  await audit(viewer.email, 'kb.document.upload', kbId, {
    filename: file.name,
    contentType,
    bytes: file.size,
  });
  revalidatePath('/admin/knowledgebases');
  return { filename: file.name };
}

export async function deleteKbDocument(input: { id: string }): Promise<void> {
  const viewer = await assertAdmin();
  const [doc] = await getDb()
    .select({ id: kbDocuments.id, kbId: kbDocuments.kbId, url: kbDocuments.url })
    .from(kbDocuments)
    .where(eq(kbDocuments.id, input.id))
    .limit(1);
  if (!doc) throw new Error('Document not found');

  // Atomic cascade for the chunks + row (no FKs in the schema). Retrieval only
  // serves chunks whose document row still exists and is 'ingested', so even if
  // the ingest cron races this delete and inserts chunks afterward, they can
  // never be served — they're just dead rows. Blob reclaimed after, best-effort.
  await getDb().transaction(async (tx) => {
    await tx.delete(kbChunks).where(eq(kbChunks.documentId, doc.id));
    await tx.delete(kbDocuments).where(eq(kbDocuments.id, doc.id));
  });
  await deleteBlobObjects([doc.url]);
  await audit(viewer.email, 'kb.document.delete', doc.kbId, { documentId: doc.id });
  revalidatePath('/admin/knowledgebases');
}

/** Re-queue a document for ingestion (e.g. after a transient failure). */
export async function retryKbDocument(input: { id: string }): Promise<void> {
  const viewer = await assertAdmin();
  const updated = await getDb()
    .update(kbDocuments)
    .set({ status: 'pending', errorMessage: null, chunkCount: 0 })
    .where(eq(kbDocuments.id, input.id))
    .returning({ id: kbDocuments.id, kbId: kbDocuments.kbId });
  if (updated.length === 0) throw new Error('Document not found');
  // Drop any stale chunks so retrieval can't serve a half-ingested document.
  await getDb().delete(kbChunks).where(eq(kbChunks.documentId, input.id));
  await audit(viewer.email, 'kb.document.retry', updated[0].kbId, { documentId: input.id });
  revalidatePath('/admin/knowledgebases');
}

export async function deleteKnowledgebase(input: { id: string }): Promise<void> {
  const viewer = await assertAdmin();

  // Blob URLs read up-front; the storage is reclaimed after the DB cascade commits.
  const docs = await getDb()
    .select({ url: kbDocuments.url })
    .from(kbDocuments)
    .where(eq(kbDocuments.kbId, input.id));

  // Atomic cascade with the attached-key guard re-checked inside the transaction,
  // so the whole thing commits or rolls back together. (The guard is still
  // best-effort against a key attached in the same instant — but an orphaned
  // pointer degrades gracefully: retrieveContext returns no context when the KB
  // is gone.)
  await getDb().transaction(async (tx) => {
    const [{ attached }] = await tx
      .select({ attached: sql<string>`count(*)` })
      .from(apiKeys)
      .where(eq(apiKeys.knowledgebaseId, input.id));
    if (Number(attached) > 0) {
      throw new Error(
        `This knowledgebase is attached to ${attached} key(s). Detach it from them first.`,
      );
    }
    await tx.delete(kbChunks).where(eq(kbChunks.kbId, input.id));
    await tx.delete(kbDocuments).where(eq(kbDocuments.kbId, input.id));
    await tx.delete(knowledgebases).where(eq(knowledgebases.id, input.id));
  });

  await deleteBlobObjects(docs.map((d) => d.url));
  await audit(viewer.email, 'kb.delete', input.id, { documents: docs.length });
  revalidatePath('/admin/knowledgebases');
}
