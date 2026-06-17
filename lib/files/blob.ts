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
import { blobUploads } from '@/db/schema';
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
  clientId: string;
  filename: string;
  contentType: string;
  data: ArrayBuffer;
}): Promise<UploadedFile> {
  const blob = await put(`uploads/${input.clientId}/${input.filename}`, input.data, {
    access: 'public',
    token: env.blobReadWriteToken(),
    contentType: input.contentType,
    addRandomSuffix: true,
  });

  await getDb().insert(blobUploads).values({
    pathname: blob.pathname,
    url: blob.url,
    apiKeyId: input.keyId,
    clientId: input.clientId,
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
 * Ensure that any referenced URL which is one of OUR blobs belongs to this
 * client. External/public URLs pass through (a client could reference those
 * anyway). Returns false if a cross-tenant blob reference is detected.
 */
export async function assertOwnedBlobs(clientId: string, urls: string[]): Promise<boolean> {
  const ours = urls.filter(isOurBlobUrl);
  if (ours.length === 0) return true;
  const rows = await getDb()
    .select({ url: blobUploads.url, clientId: blobUploads.clientId })
    .from(blobUploads)
    .where(inArray(blobUploads.url, ours));
  // Every one of our referenced blobs must be owned by this client.
  const owned = new Map(rows.map((r) => [r.url, r.clientId]));
  for (const u of ours) {
    const owner = owned.get(u);
    if (owner && owner !== clientId) return false;
  }
  return true;
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
