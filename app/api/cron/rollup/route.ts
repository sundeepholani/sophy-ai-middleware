/**
 * Idempotent maintenance cron (every 15 min). Vercel Cron is best-effort (no
 * retries; may be missed OR duplicated) so everything here is safe to re-run:
 * usage rollups are upserts and retention cleanup uses explicit expiries.
 *
 * Guarded by CRON_SECRET (Vercel sends it as a Bearer token) + a Redis lock so
 * overlapping invocations don't double-work.
 */
import { and, gte, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  CLIENT_USAGE_SOURCES,
  usageEvents,
  usageRollups,
  requestLogs,
} from '@/db/schema';
import { acquireLock, releaseLock } from '@/lib/counters';
import { sweepStaleUploads } from '@/lib/files/blob';
import { discardExpiredImageInputs } from '@/lib/usage/record';
import { processEvalRuns } from '@/lib/eval/process';
import { processKbIngestion } from '@/lib/kb/ingest';
import { env } from '@/lib/env';

const REQUEST_LOG_RETENTION_DAYS = 30;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function rollupRecentDays(): Promise<number> {
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .select({
      projectId: usageEvents.projectId,
      apiKeyId: usageEvents.apiKeyId,
      periodStart: sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`,
      requests: sql<string>`coalesce(count(*) filter (where ${usageEvents.source} = 'proxy'),0)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
      errors: sql<string>`coalesce(count(*) filter (where ${usageEvents.status} <> 'ok' and ${usageEvents.source} = 'proxy'),0)`,
    })
    .from(usageEvents)
    // One proxy row counts the uploaded clip/request and its terminal outcome.
    // A transcript-processor component contributes tokens/cost but not another
    // request or request-level error. Sophy-initiated eval/KB rows stay out.
    .where(
      and(
        gte(usageEvents.createdAt, since),
        inArray(usageEvents.source, [...CLIENT_USAGE_SOURCES]),
      ),
    )
    .groupBy(
      usageEvents.projectId,
      usageEvents.apiKeyId,
      sql`date_trunc('day', ${usageEvents.createdAt})`,
    );

  for (const r of rows) {
    if (!r.apiKeyId) continue; // client usage rows always carry a key; guard for the type
    await getDb()
      .insert(usageRollups)
      .values({
        projectId: r.projectId,
        apiKeyId: r.apiKeyId,
        periodStart: r.periodStart,
        requests: Number(r.requests),
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
        costUsd: r.cost,
        errors: Number(r.errors),
      })
      .onConflictDoUpdate({
        target: [usageRollups.projectId, usageRollups.apiKeyId, usageRollups.periodStart],
        set: {
          requests: Number(r.requests),
          inputTokens: Number(r.inputTokens),
          outputTokens: Number(r.outputTokens),
          costUsd: r.cost,
          errors: Number(r.errors),
        },
      });
  }
  return rows.length;
}

export async function GET(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${env.cronSecret()}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const locked = await acquireLock('rollup', 280);
  if (!locked) {
    return Response.json({ ok: true, skipped: 'locked' });
  }

  try {
    const rolled = await rollupRecentDays();
    // Remove complete image values before sweeping any Sophy-owned source
    // objects whose matching retention window has ended.
    const discardedImageInputs = await discardExpiredImageInputs();
    const swept = await sweepStaleUploads();
    const cutoff = new Date(Date.now() - REQUEST_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const purged = await getDb().delete(requestLogs).where(lt(requestLogs.createdAt, cutoff));
    const evals = await processEvalRuns({ batch: 25 });
    // Give KB whatever budget is left, stopping ~30s before the 300s hard kill
    // (and inside the 280s lock TTL) so it never gets killed mid-document.
    const kb = await processKbIngestion({ batch: 5, deadlineMs: startedAt + 270_000 });
    return Response.json({
      ok: true,
      rolledRows: rolled,
      discardedImageInputs,
      sweptBlobs: swept,
      purgedRequestLogs: purged.rowCount ?? 0,
      evalsJudged: evals.judged,
      evalRunsFinalized: evals.finalized,
      kbIngested: kb.ingested,
      kbFailed: kb.failed,
    });
  } catch (err) {
    console.error('[cron] rollup failed', err);
    return Response.json({ error: 'rollup_failed' }, { status: 500 });
  } finally {
    await releaseLock('rollup');
  }
}
