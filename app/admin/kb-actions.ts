'use server';

/**
 * Knowledgebase management mutations. Project admins may manage every KB;
 * editors may create KBs and manage only the ones they own. Ingestion
 * (extract → chunk → embed) happens later in the cron. Deletes reclaim the
 * blob storage and cascade to chunks; a KB that's still attached to keys can't
 * be deleted (detach first).
 */
import { revalidatePath } from 'next/cache';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { knowledgebases, kbDocuments, kbChunks, apiKeys, auditLog } from '@/db/schema';
import { requireProjectViewer, type ProjectViewer } from '@/lib/auth/viewer';
import { uploadKbDocument, deleteBlobObjects, MAX_UPLOAD_BYTES } from '@/lib/files/blob';
import { isKbContentTypeAllowed } from '@/lib/kb/extract';
import { listKbDocuments, type KbDocumentRow } from '@/lib/admin/queries';

async function audit(
  projectId: string,
  actor: string,
  action: string,
  target: string,
  after: unknown,
): Promise<void> {
  await getDb()
    .insert(auditLog)
    .values({ projectId, actor, action, target, after: after as object });
}

function revalidateKnowledgebases(projectId: string): void {
  revalidatePath(`/admin/p/${projectId}/knowledgebases`);
}

async function requireKnowledgebase(viewer: ProjectViewer, kbId: string): Promise<void> {
  const [kb] = await getDb()
    .select({
      id: knowledgebases.id,
      projectId: knowledgebases.projectId,
      ownerUserId: knowledgebases.ownerUserId,
    })
    .from(knowledgebases)
    .where(
      and(
        eq(knowledgebases.projectId, viewer.projectId),
        eq(knowledgebases.id, kbId),
      ),
    )
    .limit(1);
  if (!kb || kb.projectId !== viewer.projectId) throw new Error('Knowledgebase not found');
  if (viewer.role !== 'admin' && kb.ownerUserId !== viewer.userId) {
    throw new Error('forbidden');
  }
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

/** Documents in a KB — called by the manage dialog on open. */
export async function listKbDocumentsAction(input: {
  projectId: string;
  kbId: string;
}): Promise<KbDocumentRow[]> {
  const viewer = await requireProjectViewer(input.projectId);
  await requireKnowledgebase(viewer, input.kbId);
  return listKbDocuments(viewer, input.kbId);
}

export async function createKnowledgebase(input: {
  projectId: string;
  name: string;
}): Promise<{ id: string }> {
  const viewer = await requireProjectViewer(input.projectId);
  const name = input.name.trim();
  if (!name) throw new Error('Name is required');
  if (name.length > 200) throw new Error('Name is too long');

  const [row] = await getDb()
    .insert(knowledgebases)
    // embeddingModel uses the column default (openai/text-embedding-3-small);
    // the vector column dimension is locked to it, so it isn't operator-chosen in v1.
    .values({ projectId: input.projectId, name, ownerUserId: viewer.userId })
    .returning({ id: knowledgebases.id });

  await audit(input.projectId, viewer.email, 'kb.create', row.id, { name });
  revalidateKnowledgebases(input.projectId);
  return { id: row.id };
}

export async function uploadKbDocumentAction(
  formData: FormData,
): Promise<{ filename: string }> {
  const projectId = String(formData.get('projectId') ?? '');
  const kbId = String(formData.get('kbId') ?? '');
  const file = formData.get('file');
  if (!projectId) throw new Error('Missing project');
  const viewer = await requireProjectViewer(projectId);
  if (!kbId) throw new Error('Missing knowledgebase');
  if (!(file instanceof File) || file.size === 0) throw new Error('Choose a file to upload');

  await requireKnowledgebase(viewer, kbId);

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is too large (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB)`);
  }
  const contentType = inferContentType(file.name, file.type);
  if (!isKbContentTypeAllowed(contentType)) {
    throw new Error('Unsupported file type — upload text, Markdown, CSV, JSON, PDF, or Word (.docx)');
  }

  const data = await file.arrayBuffer();
  await uploadKbDocument({ projectId, kbId, filename: file.name, contentType, data });
  await audit(projectId, viewer.email, 'kb.document.upload', kbId, {
    filename: file.name,
    contentType,
    bytes: file.size,
  });
  revalidateKnowledgebases(projectId);
  return { filename: file.name };
}

export async function deleteKbDocument(input: { projectId: string; id: string }): Promise<void> {
  const viewer = await requireProjectViewer(input.projectId);
  const [doc] = await getDb()
    .select({
      id: kbDocuments.id,
      projectId: kbDocuments.projectId,
      kbId: kbDocuments.kbId,
      url: kbDocuments.url,
    })
    .from(kbDocuments)
    .where(and(eq(kbDocuments.projectId, input.projectId), eq(kbDocuments.id, input.id)))
    .limit(1);
  if (!doc || doc.projectId !== input.projectId) throw new Error('Document not found');
  await requireKnowledgebase(viewer, doc.kbId);

  // Atomic cascade for the chunks + row (no FKs in the schema). Retrieval only
  // serves chunks whose document row still exists and is 'ingested', so even if
  // the ingest cron races this delete and inserts chunks afterward, they can
  // never be served — they're just dead rows. Blob reclaimed after, best-effort.
  await getDb().transaction(async (tx) => {
    await tx
      .delete(kbChunks)
      .where(
        and(
          eq(kbChunks.projectId, input.projectId),
          eq(kbChunks.documentId, doc.id),
        ),
      );
    await tx
      .delete(kbDocuments)
      .where(and(eq(kbDocuments.projectId, input.projectId), eq(kbDocuments.id, doc.id)));
  });
  await deleteBlobObjects([doc.url]);
  await audit(input.projectId, viewer.email, 'kb.document.delete', doc.kbId, {
    documentId: doc.id,
  });
  revalidateKnowledgebases(input.projectId);
}

/** Re-queue a document for ingestion (e.g. after a transient failure). */
export async function retryKbDocument(input: { projectId: string; id: string }): Promise<void> {
  const viewer = await requireProjectViewer(input.projectId);
  const [doc] = await getDb()
    .select({
      id: kbDocuments.id,
      projectId: kbDocuments.projectId,
      kbId: kbDocuments.kbId,
    })
    .from(kbDocuments)
    .where(and(eq(kbDocuments.projectId, input.projectId), eq(kbDocuments.id, input.id)))
    .limit(1);
  if (!doc || doc.projectId !== input.projectId) throw new Error('Document not found');
  await requireKnowledgebase(viewer, doc.kbId);

  const updated = await getDb()
    .update(kbDocuments)
    .set({ status: 'pending', errorMessage: null, chunkCount: 0 })
    .where(and(eq(kbDocuments.projectId, input.projectId), eq(kbDocuments.id, input.id)))
    .returning({
      id: kbDocuments.id,
      projectId: kbDocuments.projectId,
      kbId: kbDocuments.kbId,
    });
  if (updated.length === 0 || updated[0].projectId !== input.projectId) {
    throw new Error('Document not found');
  }
  // Drop any stale chunks so retrieval can't serve a half-ingested document.
  await getDb()
    .delete(kbChunks)
    .where(
      and(
        eq(kbChunks.projectId, input.projectId),
        eq(kbChunks.documentId, input.id),
      ),
    );
  await audit(input.projectId, viewer.email, 'kb.document.retry', doc.kbId, {
    documentId: input.id,
  });
  revalidateKnowledgebases(input.projectId);
}

export async function deleteKnowledgebase(input: {
  projectId: string;
  id: string;
}): Promise<void> {
  const viewer = await requireProjectViewer(input.projectId);
  await requireKnowledgebase(viewer, input.id);

  // Blob URLs read up-front; the storage is reclaimed after the DB cascade commits.
  const docs = await getDb()
    .select({ url: kbDocuments.url })
    .from(kbDocuments)
    .where(
      and(eq(kbDocuments.projectId, input.projectId), eq(kbDocuments.kbId, input.id)),
    );

  // Atomic cascade with the attached-key guard re-checked inside the transaction,
  // so the whole thing commits or rolls back together. (The guard is still
  // best-effort against a key attached in the same instant — but an orphaned
  // pointer degrades gracefully: retrieveContext returns no context when the KB
  // is gone.)
  await getDb().transaction(async (tx) => {
    const [{ attached }] = await tx
      .select({ attached: sql<string>`count(*)` })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.projectId, input.projectId),
          eq(apiKeys.knowledgebaseId, input.id),
        ),
      );
    if (Number(attached) > 0) {
      throw new Error(
        `This knowledgebase is attached to ${attached} key(s). Detach it from them first.`,
      );
    }
    await tx
      .delete(kbChunks)
      .where(and(eq(kbChunks.projectId, input.projectId), eq(kbChunks.kbId, input.id)));
    await tx
      .delete(kbDocuments)
      .where(
        and(eq(kbDocuments.projectId, input.projectId), eq(kbDocuments.kbId, input.id)),
      );
    const deleted = await tx
      .delete(knowledgebases)
      .where(
        and(
          eq(knowledgebases.projectId, input.projectId),
          eq(knowledgebases.id, input.id),
          viewer.role === 'admin'
            ? undefined
            : eq(knowledgebases.ownerUserId, viewer.userId),
        ),
      )
      .returning({ id: knowledgebases.id });
    if (deleted.length === 0) throw new Error('Knowledgebase not found');
  });

  await deleteBlobObjects(docs.map((d) => d.url));
  await audit(input.projectId, viewer.email, 'kb.delete', input.id, {
    documents: docs.length,
  });
  revalidateKnowledgebases(input.projectId);
}
