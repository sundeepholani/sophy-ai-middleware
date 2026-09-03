/**
 * Client file uploads via Vercel Blob.
 *
 * Security posture (per design review): every upload is bound to the issuing
 * key/client in Postgres; references to OUR blobs are ownership-checked on use;
 * a content-type allowlist and per-file size cap are enforced at upload; and an
 * idempotent cron sweep deletes stale uploads. Blobs are public-but-unguessable
 * so the provider can fetch them — access control is enforced by us, not the URL.
 */
import { put, del } from '@vercel/blob';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { ModelMessage } from 'ai';
import { getDb } from '@/db/client';
import { blobUploads, kbDocuments } from '@/db/schema';
import { env } from '@/lib/env';
import type { OpenAIMessage } from '@/lib/http/openai';

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4 MB (stays under the 4.5 MB function body cap)

export const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/csv',
  'application/json',
]);

export interface UploadedFile {
  id: string;
  url: string;
  pathname: string;
  filename: string;
  bytes: number;
  contentType: string;
}

export async function uploadClientFile(input: {
  projectId: string;
  keyId: string;
  filename: string;
  contentType: string;
  data: ArrayBuffer;
}): Promise<UploadedFile> {
  // Build the blob key from a sanitized single path segment so a hostile
  // filename ("../<otherKeyId>/…", control chars, absurd length) can't escape
  // the uploads/<projectId>/<keyId>/ namespace. The original filename is kept in
  // blob_uploads / returned for display; the blob key only needs to be safe and
  // unique (addRandomSuffix).
  const safeName =
    (input.filename || 'document')
      .split('/')
      .pop()!
      .replace(/[^\w.\- ]+/g, '_')
      .slice(0, 200) || 'document';
  const blob = await put(`uploads/${input.projectId}/${input.keyId}/${safeName}`, input.data, {
    access: 'public',
    token: env.blobReadWriteToken(),
    contentType: input.contentType,
    addRandomSuffix: true,
  });

  await getDb().insert(blobUploads).values({
    projectId: input.projectId,
    pathname: blob.pathname,
    url: blob.url,
    apiKeyId: input.keyId,
    contentType: input.contentType,
    size: input.data.byteLength,
  });

  return {
    id: blob.url,
    url: blob.url,
    pathname: blob.pathname,
    filename: input.filename,
    bytes: input.data.byteLength,
    contentType: input.contentType,
  };
}

export interface UploadedKbDocument {
  id: string;
  url: string;
  pathname: string;
  filename: string;
  bytes: number;
  contentType: string;
}

/**
 * Upload a KB source document to Blob and record it in `kb_documents` as
 * `pending` (the cron ingests it later). Deliberately NOT recorded in
 * `blob_uploads`, so `sweepStaleUploads` never deletes a knowledgebase file.
 * KB files live under their own `kb/<projectId>/<kbId>/` namespace.
 */
export async function uploadKbDocument(input: {
  projectId: string;
  kbId: string;
  filename: string;
  contentType: string;
  data: ArrayBuffer;
}): Promise<UploadedKbDocument> {
  // Build the blob key from a sanitized single path segment so a hostile
  // filename ("../…", control chars, absurd length) can't escape the
  // kb/<projectId>/<kbId>/ namespace. The original filename is kept in
  // kb_documents for display; the blob key only needs to be safe and unique
  // (addRandomSuffix).
  const safeName =
    (input.filename || 'document')
      .split('/')
      .pop()!
      .replace(/[^\w.\- ]+/g, '_')
      .slice(0, 200) || 'document';
  const blob = await put(`kb/${input.projectId}/${input.kbId}/${safeName}`, input.data, {
    access: 'public',
    token: env.blobReadWriteToken(),
    contentType: input.contentType,
    addRandomSuffix: true,
  });

  const [row] = await getDb()
    .insert(kbDocuments)
    .values({
      projectId: input.projectId,
      kbId: input.kbId,
      filename: input.filename,
      pathname: blob.pathname,
      url: blob.url,
      contentType: input.contentType,
      bytes: input.data.byteLength,
      status: 'pending',
    })
    .returning({ id: kbDocuments.id });

  return {
    id: row.id,
    url: blob.url,
    pathname: blob.pathname,
    filename: input.filename,
    bytes: input.data.byteLength,
    contentType: input.contentType,
  };
}

type ManagedBlobNamespace = 'uploads' | 'kb';

/**
 * Recognize only the path prefixes Sophy owns on Vercel Blob. Other public
 * Vercel Blob objects remain external URLs; managed paths are fail-closed below
 * because their database ownership row is the authorization source of truth.
 */
function managedBlobNamespace(url: string): ManagedBlobNamespace | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'blob.vercel-storage.com' && !host.endsWith('.blob.vercel-storage.com')) {
      return null;
    }
    let segment = parsed.pathname.replace(/^\/+/, '').split('/', 1)[0] ?? '';
    // Check before decoding as well as after it: an unrelated malformed escape
    // later in `/uploads/...` must not make an otherwise managed URL pass as an
    // external one. A second bounded decode covers an encoded path separator.
    for (let depth = 0; depth < 3; depth++) {
      const root = segment.replace(/^\/+/, '').split('/', 1)[0]?.toLowerCase();
      if (root === 'uploads' || root === 'kb') return root;
      try {
        const decoded = decodeURIComponent(segment);
        if (decoded === segment) break;
        segment = decoded;
      } catch {
        break;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Collect file/image URLs referenced in message content. */
export function extractReferencedUrls(messages: OpenAIMessage[]): string[] {
  const urls: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type === 'image_url' && part.image_url?.url) urls.push(part.image_url.url);
      // Mirror the sink (partToModelPart) exactly: it forwards `file_url ?? file_data`,
      // so BOTH fields must be ownership-checked. Collecting only file_url would let a
      // cross-key blob URL smuggled through file_data bypass assertOwnedBlobs.
      if (part.type === 'file' && part.file) {
        const fileUrl = part.file.file_url ?? part.file.file_data;
        if (fileUrl) urls.push(fileUrl);
      }
    }
  }
  return urls;
}

/**
 * Ensure that every referenced URL in a Sophy-managed Blob namespace is an
 * upload owned by this exact project + key. External/public URLs pass through
 * (a client could reference those anyway). Managed URLs fail closed when the
 * database row is absent; this also prevents API keys from directly reading
 * operator-curated `kb/` source documents, which are intentionally not blobUploads.
 */
export async function assertOwnedBlobs(
  projectId: string,
  keyId: string,
  urls: string[],
  options?: {
    /** Normalized image URLs that are actually sent to the model. */
    retainImageUrls?: string[];
    /** Shared seven-day deadline for the request log and managed source object. */
    retainUntil?: Date;
  },
): Promise<boolean> {
  const managed = [...new Set(urls.filter((url) => managedBlobNamespace(url) != null))];
  if (managed.length === 0) return true;
  const retainedManaged = [
    ...new Set(
      (options?.retainImageUrls ?? []).filter((url) => managed.includes(url)),
    ),
  ];

  const inspect = async (
    db: Pick<ReturnType<typeof getDb>, 'select' | 'update'>,
    lockRows: boolean,
  ): Promise<boolean> => {
    const query = db
      .select({
        url: blobUploads.url,
        projectId: blobUploads.projectId,
        apiKeyId: blobUploads.apiKeyId,
      })
      .from(blobUploads)
      .where(
        and(
          eq(blobUploads.projectId, projectId),
          eq(blobUploads.apiKeyId, keyId),
          inArray(blobUploads.url, managed),
        ),
      );
    const rows = await (lockRows ? query.for('update') : query);
    const owned = new Set(
      rows
        .filter((row) => row.projectId === projectId && row.apiKeyId === keyId)
        .map((row) => row.url),
    );
    if (managed.some((url) => !owned.has(url))) return false;

    if (options?.retainUntil && retainedManaged.length > 0) {
      await db
        .update(blobUploads)
        .set({ expiresAt: options.retainUntil })
        .where(
          and(
            eq(blobUploads.projectId, projectId),
            eq(blobUploads.apiKeyId, keyId),
            inArray(blobUploads.url, retainedManaged),
            lte(blobUploads.expiresAt, options.retainUntil),
          ),
        );
    }
    return true;
  };

  const db = getDb();
  if (options?.retainUntil && retainedManaged.length > 0) {
    // Lock the same upload rows as the sweeper. Whichever transaction wins is
    // decisive: either retention extends before cleanup can select the object,
    // or cleanup removes the row and this request fails closed before model use.
    return db.transaction((tx) => inspect(tx, true));
  }
  return inspect(db, false);
}

/** Extract the normalized image URLs that are actually forwarded to a model. */
export function extractModelImageUrls(messages: ModelMessage[]): string[] {
  const urls: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object' || part.type !== 'image') continue;
      const image = (part as { image?: unknown }).image;
      if (image instanceof URL) urls.push(image.href);
      else if (typeof image === 'string') urls.push(image);
    }
  }
  return [...new Set(urls)];
}

/**
 * Delete blob objects by URL (best-effort). Used when an admin deletes a KB
 * document or knowledgebase — the DB rows are removed by the caller; this just
 * reclaims the underlying storage. Never throws (a failed delete leaves an
 * orphan object, which is harmless and out of any namespace we read).
 */
export async function deleteBlobObjects(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  await del(urls, { token: env.blobReadWriteToken() }).catch(() =>
    console.error('[blob] del failed'),
  );
}

/**
 * Idempotent cron sweep for uploads whose explicit retention has ended.
 * Metadata is removed only after Blob confirms deletion; a failed object delete
 * leaves the row in place so the next cron can retry instead of orphaning data.
 */
export async function sweepStaleUploads(now = new Date()): Promise<number> {
  return getDb().transaction(async (tx) => {
    const stale = await tx
      .select({ pathname: blobUploads.pathname, url: blobUploads.url })
      .from(blobUploads)
      .where(lte(blobUploads.expiresAt, now))
      .limit(500)
      .for('update', { skipLocked: true });
    if (stale.length === 0) return 0;

    try {
      await del(
        stale.map((s) => s.url),
        { token: env.blobReadWriteToken() },
      );
    } catch {
      console.error('[blob] del failed; retaining metadata for retry');
      return 0;
    }

    await tx
      .delete(blobUploads)
      .where(
        and(
          inArray(
            blobUploads.pathname,
            stale.map((s) => s.pathname),
          ),
          lte(blobUploads.expiresAt, now),
        ),
      );
    return stale.length;
  });
}
