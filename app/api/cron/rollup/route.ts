/**
 * Idempotent maintenance cron (every 15 min). Vercel Cron is best-effort (no
 * retries; may be missed OR duplicated) so everything here is safe to re-run:
 * usage rollups are upserts and the blob sweep is a delete-if-older-than.
 *
 * Guarded by CRON_SECRET (Vercel sends it as a Bearer token) + a Redis lock so
 * overlapping invocations don't double-work.
 */
import { gte, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { usageEvents, usageRollups, requestLogs } from '@/db/schema';
import { acquireLock, releaseLock } from '@/lib/counters';
import { sweepStaleUploads } from '@/lib/files/blob';
import { env } from '@/lib/env';

const REQUEST_LOG_RETENTION_DAYS = 30;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function rollupRecentDays(): Promise<number> {
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .select({
      apiKeyId: usageEvents.apiKeyId,
      periodStart: sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`,
      requests: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
      errors: sql<string>`coalesce(count(*) filter (where ${usageEvents.status} <> 'ok'),0)`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))
    .groupBy(usageEvents.apiKeyId, sql`date_trunc('day', ${usageEvents.createdAt})`);

  for (const r of rows) {
    await getDb()
      .insert(usageRollups)
      .values({
        apiKeyId: r.apiKeyId,
        periodStart: r.periodStart,
        requests: Number(r.requests),
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
        costUsd: r.cost,
        errors: Number(r.errors),
      })
      .onConflictDoUpdate({
        target: [usageRollups.apiKeyId, usageRollups.periodStart],
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
    const swept = await sweepStaleUploads(24);
    const cutoff = new Date(Date.now() - REQUEST_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const purged = await getDb().delete(requestLogs).where(lt(requestLogs.createdAt, cutoff));
    return Response.json({
      ok: true,
      rolledRows: rolled,
      sweptBlobs: swept,
      purgedRequestLogs: purged.rowCount ?? 0,
    });
  } catch (err) {
    console.error('[cron] rollup failed', err);
    return Response.json({ error: 'rollup_failed' }, { status: 500 });
  } finally {
    await releaseLock('rollup');
  }
}
