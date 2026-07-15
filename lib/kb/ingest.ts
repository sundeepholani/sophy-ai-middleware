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
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { kbDocuments, kbChunks, knowledgebases } from '@/db/schema';
import { extractText } from '@/lib/kb/extract';
import { chunkText } from '@/lib/kb/chunk';
import { embedTexts, EMBEDDING_DIM } from '@/lib/kb/embed';
import { recordUsage } from '@/lib/usage/record';
import { providerOf } from '@/lib/gateway/call';
import {
  normalizeProjectGatewayError,
  ProjectGatewayUnavailableError,
  resolveProjectGateway,
  type ProjectGatewaySnapshot,
} from '@/lib/gateway/project-provider';
import { safeGatewayErrorMessage } from '@/lib/gateway/upstream-error';

const DOWNLOAD_TIMEOUT_MS = 30_000;
// Bound the paid embed call: a hung/slow gateway must not eat the whole cron
// budget. On timeout this throws → the per-doc catch marks the doc 'failed'.
const EMBED_TIMEOUT_MS = 120_000;
const INSERT_BATCH = 200; // rows per insert, to bound statement size
const GATEWAY_RETRY_MARKER = 'project_gateway_unavailable:';
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
      projectId: kbDocuments.projectId,
      kbId: kbDocuments.kbId,
      url: kbDocuments.url,
      filename: kbDocuments.filename,
      contentType: kbDocuments.contentType,
      embeddingModel: knowledgebases.embeddingModel,
    })
    .from(kbDocuments)
    .innerJoin(
      knowledgebases,
      and(
        eq(kbDocuments.kbId, knowledgebases.id),
        eq(kbDocuments.projectId, knowledgebases.projectId),
      ),
    )
    .where(eq(kbDocuments.status, 'pending'))
    .orderBy(
      // A project with a disconnected gateway must not monopolize the oldest
      // global rows. Always make progress on fresh work first, then rotate the
      // blocked rows by their last-attempt timestamp (stored in errorMessage so
      // this remains recoverable without a schema-only retry queue migration).
      sql`case when ${kbDocuments.errorMessage} like 'project_gateway_unavailable%' then 1 else 0 end`,
      sql`case when ${kbDocuments.errorMessage} like 'project_gateway_unavailable%' then ${kbDocuments.errorMessage} end`,
      asc(kbDocuments.createdAt),
    )
    .limit(batch);

  let ingested = 0;
  let failed = 0;
  // One immutable credential snapshot per project for this cron invocation.
  const gateways = new Map<string, Promise<ProjectGatewaySnapshot>>();
  const gatewayFor = (projectId: string) => {
    let pendingGateway = gateways.get(projectId);
    if (!pendingGateway) {
      pendingGateway = resolveProjectGateway(projectId);
      gateways.set(projectId, pendingGateway);
    }
    return pendingGateway;
  };

  for (const doc of pending) {
    // Start a doc only if its worst case fits the remaining budget. Gating on the
    // doc's full reserve (not just "are we past the deadline") is what prevents a
    // mid-document hard-kill and the resulting re-download + re-billed embed.
    if (Date.now() + PER_DOC_RESERVE_MS > deadlineMs) break; // out of budget — leave the rest pending
    let gateway: ProjectGatewaySnapshot | undefined;
    let stage: 'resolve' | 'download' | 'extract' | 'embed' | 'insert' = 'resolve';
    let embedStartedAt: number | undefined;
    let embedUsageRecorded = false;
    try {
      gateway = await gatewayFor(doc.projectId);
      // Idempotency: clear any chunks from a prior partial run for this doc.
      await db
        .delete(kbChunks)
        .where(
          and(
            eq(kbChunks.projectId, doc.projectId),
            eq(kbChunks.documentId, doc.id),
          ),
        );

      stage = 'download';
      const res = await fetch(doc.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const data = await res.arrayBuffer();

      stage = 'extract';
      const text = await extractText({ contentType: doc.contentType ?? '', data });
      const chunks = chunkText(text);
      if (chunks.length === 0) throw new Error('no extractable text');

      stage = 'embed';
      embedStartedAt = Date.now();
      const { embeddings, tokens, costUsd } = await embedTexts(gateway, doc.embeddingModel, chunks, {
        abortSignal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        maxRetries: 1,
      });
      // Book the paid embed call (source='kb_ingest'). No owning key — ingestion
      // is operator/cron work — so api_key_id is null and this spend stays out
      // of every key quota. recordUsage never throws into this path.
      await recordUsage({
        projectId: doc.projectId,
        gatewayCredentialId: gateway.gatewayCredentialId,
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
        latencyMs: Date.now() - embedStartedAt,
        status: 'ok',
        responseKind: 'embedding',
      });
      embedUsageRecorded = true;
      if (embeddings.length !== chunks.length) {
        throw new Error(`embedding count mismatch: ${embeddings.length} vs ${chunks.length}`);
      }
      for (const e of embeddings) {
        if (!Array.isArray(e) || e.length !== EMBEDDING_DIM) {
          throw new Error(`unexpected embedding dim ${e?.length} (want ${EMBEDDING_DIM})`);
        }
      }

      stage = 'insert';
      const rows = chunks.map((content, i) => ({
        projectId: doc.projectId,
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
        .where(
          and(
            eq(kbDocuments.projectId, doc.projectId),
            eq(kbDocuments.id, doc.id),
          ),
        );
      ingested++;
      console.info(
        `[kb] ingested ${doc.filename} (${doc.id}): ${chunks.length} chunks, ${tokens ?? '?'} embed tokens`,
      );
    } catch (err) {
      const normalizedError = gateway
        ? await normalizeProjectGatewayError(gateway, err)
        : err;
      if (gateway && stage === 'embed' && embedStartedAt !== undefined && !embedUsageRecorded) {
        await recordUsage({
          projectId: doc.projectId,
          gatewayCredentialId: gateway.gatewayCredentialId,
          keyId: null,
          source: 'kb_ingest',
          provider: providerOf(doc.embeddingModel),
          model: doc.embeddingModel,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
          latencyMs: Date.now() - embedStartedAt,
          status: 'error',
          responseKind: 'embedding',
          errorMessage: safeGatewayErrorMessage(normalizedError),
        });
      }
      const credentialUnavailable = ProjectGatewayUnavailableError.isInstance(normalizedError);
      const errorMessage = credentialUnavailable
        // Refresh the retry marker on every blocked attempt. Combined with the
        // pending-query ordering above this moves the row to the back of the
        // blocked queue, so one broken project cannot starve another project.
        ? `${GATEWAY_RETRY_MARKER}${new Date().toISOString()}`
        : stage === 'embed'
          ? safeGatewayErrorMessage(normalizedError)
          : normalizedError instanceof Error
            ? normalizedError.message.slice(0, 500)
            : String(normalizedError).slice(0, 500);
      await db
        .update(kbDocuments)
        .set({
          // Credential outages are recoverable after an admin reconnects the
          // project. Leave the document pending instead of making that outage a
          // permanent document failure.
          ...(credentialUnavailable ? {} : { status: 'failed' as const }),
          errorMessage,
        })
        .where(
          and(
            eq(kbDocuments.projectId, doc.projectId),
            eq(kbDocuments.id, doc.id),
          ),
        );
      failed++;
      console.error('[kb] ingestion failed', {
        documentId: doc.id,
        projectId: doc.projectId,
        stage,
        credentialUnavailable,
      });
    }
  }

  return { ingested, failed };
}
