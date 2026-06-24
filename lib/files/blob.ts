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
import { inArray, lt } from 'drizzle-orm';
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
  keyId: string;
  filename: string;
  contentType: string;
  data: ArrayBuffer;
}): Promise<UploadedFile> {
  // Build the blob key from a sanitized single path segment so a hostile
  // filename ("../<otherKeyId>/…", control chars, absurd length) can't escape
  // the uploads/<keyId>/ namespace. The original filename is kept in
  // blob_uploads / returned for display; the blob key only needs to be safe and
  // unique (addRandomSuffix).
  const safeName =
    (input.filename || 'document')
      .split('/')
      .pop()!
      .replace(/[^\w.\- ]+/g, '_')
      .slice(0, 200) || 'document';
  const blob = await put(`uploads/${input.keyId}/${safeName}`, input.data, {
    access: 'public',
    token: env.blobReadWriteToken(),
    contentType: input.contentType,
    addRandomSuffix: true,
  });

  await getDb().insert(blobUploads).values({
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
 * KB files live under their own `kb/<kbId>/` namespace.
 */
export async function uploadKbDocument(input: {
  kbId: string;
  filename: string;
  contentType: string;
  data: ArrayBuffer;
}): Promise<UploadedKbDocument> {
  // Build the blob key from a sanitized single path segment so a hostile
  // filename ("../…", control chars, absurd length) can't escape the
  // kb/<kbId>/ namespace. The original filename is kept in kb_documents for
  // display; the blob key only needs to be safe and unique (addRandomSuffix).
  const safeName =
    (input.filename || 'document')
      .split('/')
      .pop()!
      .replace(/[^\w.\- ]+/g, '_')
      .slice(0, 200) || 'document';
  const blob = await put(`kb/${input.kbId}/${safeName}`, input.data, {
    access: 'public',
    token: env.blobReadWriteToken(),
    contentType: input.contentType,
    addRandomSuffix: true,
  });

  const [row] = await getDb()
    .insert(kbDocuments)
    .values({
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

function isOurBlobUrl(url: string): boolean {
  try {
    return new URL(url).host.includes('blob.vercel-storage.com');
  } catch {
    return false;
  }
}

/** Collect file/image URLs referenced in message content. */
export function extractReferencedUrls(messages: OpenAIMessage[]): string[] {
  const urls: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type === 'image_url' && part.image_url?.url) urls.push(part.image_url.url);
      if (part.type === 'file' && part.file?.file_url) urls.push(part.file.file_url);
    }
  }
  return urls;
}

/**
 * Ensure that any referenced URL which is one of OUR blobs belongs to this key.
 * External/public URLs pass through (a client could reference those anyway).
 * Returns false if a cross-key blob reference is detected.
 */
export async function assertOwnedBlobs(keyId: string, urls: string[]): Promise<boolean> {
  const ours = urls.filter(isOurBlobUrl);
  if (ours.length === 0) return true;
  const rows = await getDb()
    .select({ url: blobUploads.url, apiKeyId: blobUploads.apiKeyId })
    .from(blobUploads)
    .where(inArray(blobUploads.url, ours));
  const owned = new Map(rows.map((r) => [r.url, r.apiKeyId]));
  for (const u of ours) {
    const owner = owned.get(u);
    if (owner && owner !== keyId) return false;
  }
  return true;
}

/**
 * Delete blob objects by URL (best-effort). Used when an admin deletes a KB
 * document or knowledgebase — the DB rows are removed by the caller; this just
 * reclaims the underlying storage. Never throws (a failed delete leaves an
 * orphan object, which is harmless and out of any namespace we read).
 */
export async function deleteBlobObjects(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  await del(urls, { token: env.blobReadWriteToken() }).catch((err) =>
    console.error('[blob] del failed', err),
  );
}

/** Idempotent cron sweep: delete uploads older than N hours. Returns count. */
export async function sweepStaleUploads(olderThanHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  const stale = await getDb()
    .select({ pathname: blobUploads.pathname, url: blobUploads.url })
    .from(blobUploads)
    .where(lt(blobUploads.createdAt, cutoff))
    .limit(500);
  if (stale.length === 0) return 0;

  await del(
    stale.map((s) => s.url),
    { token: env.blobReadWriteToken() },
  ).catch((err) => console.error('[blob] del failed', err));

  await getDb()
    .delete(blobUploads)
    .where(
      inArray(
        blobUploads.pathname,
        stale.map((s) => s.pathname),
      ),
    );
  return stale.length;
}
