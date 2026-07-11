/**
 * KB ingestion, driven by the cron. For each pending document: download the
 * blob, extract text, chunk it, embed the chunks via the gateway, and insert
 * kb_chunks — then mark the document ingested (or failed, with the reason).
 *
 * Bounded per invocation (batch) and idempotent: it only ever picks up
 * `pending` docs and flips them to a terminal state, and it deletes any chunks
 * left from a prior partial run before re-inserting — so a crash mid-ingest
 * just gets retried cleanly on the next cron tick. The cron lock prevents
 * overlapping invocations, so no extra per-doc claim is needed.
 */
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { kbDocuments, kbChunks, knowledgebases } from '@/db/schema';
import { extractText } from '@/lib/kb/extract';
import { chunkText } from '@/lib/kb/chunk';
import { embedTexts, EMBEDDING_DIM } from '@/lib/kb/embed';
import { recordUsage } from '@/lib/usage/record';
import { providerOf } from '@/lib/gateway/call';

const DOWNLOAD_TIMEOUT_MS = 30_000;
// Bound the paid embed call: a hung/slow gateway must not eat the whole cron
// budget. On timeout this throws → the per-doc catch marks the doc 'failed'.
const EMBED_TIMEOUT_MS = 120_000;
const INSERT_BATCH = 200; // rows per insert, to bound statement size
// Worst-case wall-clock a single document can consume before its terminal status
// flip: download ceiling + embed ceiling + slack for extract/chunk/insert. We use
// this to gate the START of each doc (below) so we never begin one we can't finish
// before the function's hard kill — a mid-doc kill clears the doc's chunks and
// leaves it 'pending', forcing the whole (paid) download+embed to redo next tick.
const PER_DOC_RESERVE_MS = DOWNLOAD_TIMEOUT_MS + EMBED_TIMEOUT_MS + 20_000;

export async function processKbIngestion(opts?: { batch?: number; deadlineMs?: number }): Promise<{
  ingested: number;
  failed: number;
}> {
  const db = getDb();
  const batch = opts?.batch ?? 5;
  // Wall-clock budget shared with the rest of the cron. We never *start* a
  // document we likely can't finish before the function is hard-killed — a
  // mid-doc kill would just leave it 'pending' and re-do (and re-bill) the
  // whole thing next tick. Stopping early is clean: the doc is retried later.
  const deadlineMs = opts?.deadlineMs ?? Infinity;

  const pending = await db
    .select({
      id: kbDocuments.id,
      kbId: kbDocuments.kbId,
      url: kbDocuments.url,
      filename: kbDocuments.filename,
      contentType: kbDocuments.contentType,
      embeddingModel: knowledgebases.embeddingModel,
    })
    .from(kbDocuments)
    .innerJoin(knowledgebases, eq(kbDocuments.kbId, knowledgebases.id))
    .where(eq(kbDocuments.status, 'pending'))
    .orderBy(asc(kbDocuments.createdAt)) // oldest first → deterministic progress
    .limit(batch);

  let ingested = 0;
  let failed = 0;

  for (const doc of pending) {
    // Start a doc only if its worst case fits the remaining budget. Gating on the
    // doc's full reserve (not just "are we past the deadline") is what prevents a
    // mid-document hard-kill and the resulting re-download + re-billed embed.
    if (Date.now() + PER_DOC_RESERVE_MS > deadlineMs) break; // out of budget — leave the rest pending
    try {
      // Idempotency: clear any chunks from a prior partial run for this doc.
      await db.delete(kbChunks).where(eq(kbChunks.documentId, doc.id));

      const res = await fetch(doc.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const data = await res.arrayBuffer();

      const text = await extractText({ contentType: doc.contentType ?? '', data });
      const chunks = chunkText(text);
      if (chunks.length === 0) throw new Error('no extractable text');

      const embedStart = Date.now();
      const { embeddings, tokens, costUsd } = await embedTexts(doc.embeddingModel, chunks, {
        abortSignal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        maxRetries: 1,
      });
      // Book the paid embed call (source='kb_ingest'). No owning key — ingestion
      // is operator/cron work — so api_key_id is null and this spend stays out
      // of every key quota. recordUsage never throws into this path.
      await recordUsage({
        keyId: null,
        source: 'kb_ingest',
        provider: providerOf(doc.embeddingModel),
        model: doc.embeddingModel,
        usage: {
          inputTokens: tokens ?? 0,
          outputTokens: 0,
          totalTokens: tokens ?? 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd,
        latencyMs: Date.now() - embedStart,
        status: 'ok',
        responseKind: 'embedding',
      });
      if (embeddings.length !== chunks.length) {
        throw new Error(`embedding count mismatch: ${embeddings.length} vs ${chunks.length}`);
      }
      for (const e of embeddings) {
        if (!Array.isArray(e) || e.length !== EMBEDDING_DIM) {
          throw new Error(`unexpected embedding dim ${e?.length} (want ${EMBEDDING_DIM})`);
        }
      }

      const rows = chunks.map((content, i) => ({
        kbId: doc.kbId,
        documentId: doc.id,
        chunkIndex: i,
        content,
        embedding: embeddings[i],
      }));
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        await db.insert(kbChunks).values(rows.slice(i, i + INSERT_BATCH));
      }

      await db
        .update(kbDocuments)
        .set({
          status: 'ingested',
          chunkCount: chunks.length,
          ingestedAt: new Date(),
          errorMessage: null,
        })
        .where(eq(kbDocuments.id, doc.id));
      ingested++;
      console.info(
        `[kb] ingested ${doc.filename} (${doc.id}): ${chunks.length} chunks, ${tokens ?? '?'} embed tokens`,
      );
    } catch (err) {
      await db
        .update(kbDocuments)
        .set({
          status: 'failed',
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err),
        })
        .where(eq(kbDocuments.id, doc.id));
      failed++;
      console.error(`[kb] ingestion failed for ${doc.id}`, err);
    }
  }

  return { ingested, failed };
}
