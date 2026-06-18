/**
 * Read-side queries for the admin console (server components only).
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  apiKeys,
  usageEvents,
  requestLogs,
  evalRuns,
  evalSamples,
  type KeyParams,
  type EvalRunStatus,
} from '@/db/schema';
import type { EvalSummary } from '@/lib/eval/aggregate';

export async function getOverview() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [agg] = await getDb()
    .select({
      requests: sql<string>`coalesce(count(*),0)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
      errors: sql<string>`coalesce(count(*) filter (where ${usageEvents.status} <> 'ok'),0)`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since));
  return {
    requests: Number(agg?.requests ?? 0),
    inputTokens: Number(agg?.inputTokens ?? 0),
    outputTokens: Number(agg?.outputTokens ?? 0),
    cost: Number(agg?.cost ?? 0),
    errors: Number(agg?.errors ?? 0),
  };
}

export interface KeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  keyLast4: string;
  model: string;
  systemPrompt: string | null;
  params: KeyParams;
  outputSchema: Record<string, unknown> | null;
  monthlyTokenCap: number | null;
  rpmLimit: number | null;
  logContent: boolean;
  status: string;
}

export async function listKeys(): Promise<KeyRow[]> {
  const rows = await getDb()
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      keyLast4: apiKeys.keyLast4,
      model: apiKeys.model,
      systemPrompt: apiKeys.systemPrompt,
      params: apiKeys.params,
      outputSchema: apiKeys.outputSchema,
      monthlyTokenCap: apiKeys.monthlyTokenCap,
      rpmLimit: apiKeys.rpmLimit,
      logContent: apiKeys.logContent,
      status: apiKeys.status,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => ({ ...r, outputSchema: r.outputSchema ?? null }));
}

/** Filters shared by every usage query (range + optional key/model). */
export interface UsageFilters {
  sinceDays: number;
  keyId?: string;
  model?: string;
}

function usageWhere(f: UsageFilters) {
  const since = new Date(Date.now() - f.sinceDays * 24 * 60 * 60 * 1000);
  const conds = [gte(usageEvents.createdAt, since)];
  if (f.keyId) conds.push(eq(usageEvents.apiKeyId, f.keyId));
  if (f.model) conds.push(eq(usageEvents.model, f.model));
  return and(...conds);
}

const tokensExpr = sql`${usageEvents.inputTokens} + ${usageEvents.outputTokens}`;

export async function getUsageSeries(f: UsageFilters) {
  const rows = await getDb()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`,
      requests: sql<string>`count(*)`,
      tokens: sql<string>`coalesce(sum(${tokensExpr}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .where(usageWhere(f))
    .groupBy(sql`date_trunc('day', ${usageEvents.createdAt})`)
    .orderBy(sql`date_trunc('day', ${usageEvents.createdAt})`);
  return rows.map((r) => ({
    day: r.day,
    requests: Number(r.requests),
    tokens: Number(r.tokens),
    cost: Number(r.cost),
  }));
}

export async function getUsageTotals(f: UsageFilters) {
  const [agg] = await getDb()
    .select({
      requests: sql<string>`coalesce(count(*),0)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .where(usageWhere(f));
  return {
    requests: Number(agg?.requests ?? 0),
    inputTokens: Number(agg?.inputTokens ?? 0),
    outputTokens: Number(agg?.outputTokens ?? 0),
    cost: Number(agg?.cost ?? 0),
  };
}

export interface UsageBreakdownRow {
  label: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export async function getUsageByKey(f: UsageFilters): Promise<UsageBreakdownRow[]> {
  const rows = await getDb()
    .select({
      keyId: usageEvents.apiKeyId,
      keyName: apiKeys.name,
      requests: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .leftJoin(apiKeys, eq(usageEvents.apiKeyId, apiKeys.id))
    .where(usageWhere(f))
    .groupBy(usageEvents.apiKeyId, apiKeys.name)
    .orderBy(desc(sql`sum(${tokensExpr})`));
  return rows.map((r) => ({
    label: r.keyName ?? `${r.keyId.slice(0, 8)}… (deleted)`,
    requests: Number(r.requests),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cost: Number(r.cost),
  }));
}

export async function getUsageByModel(f: UsageFilters): Promise<UsageBreakdownRow[]> {
  const rows = await getDb()
    .select({
      model: usageEvents.model,
      requests: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .where(usageWhere(f))
    .groupBy(usageEvents.model)
    .orderBy(desc(sql`sum(${tokensExpr})`));
  return rows.map((r) => ({
    label: r.model ?? '—',
    requests: Number(r.requests),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cost: Number(r.cost),
  }));
}

/** Distinct models seen in the last 90 days — drives the model filter dropdown. */
export async function listUsedModels(): Promise<string[]> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .selectDistinct({ model: usageEvents.model })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))
    .orderBy(usageEvents.model);
  return rows.map((r) => r.model).filter((m): m is string => !!m);
}

export async function getLogDetail(id: string) {
  const db = getDb();
  const [event] = await db
    .select({
      id: usageEvents.id,
      createdAt: usageEvents.createdAt,
      apiKeyId: usageEvents.apiKeyId,
      keyName: apiKeys.name,
      provider: usageEvents.provider,
      model: usageEvents.model,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      costUsd: usageEvents.costUsd,
      latencyMs: usageEvents.latencyMs,
      status: usageEvents.status,
      streamed: usageEvents.streamed,
      responseKind: usageEvents.responseKind,
      errorMessage: usageEvents.errorMessage,
    })
    .from(usageEvents)
    .leftJoin(apiKeys, eq(usageEvents.apiKeyId, apiKeys.id))
    .where(eq(usageEvents.id, id))
    .limit(1);
  if (!event) return null;
  const [content] = await db
    .select({
      surface: requestLogs.surface,
      systemPrompt: requestLogs.systemPrompt,
      request: requestLogs.request,
      response: requestLogs.response,
    })
    .from(requestLogs)
    .where(eq(requestLogs.id, id))
    .limit(1);
  return { event, content: content ?? null };
}

export async function getRecentLogs(limit = 100) {
  return getDb()
    .select({
      id: usageEvents.id,
      createdAt: usageEvents.createdAt,
      apiKeyId: usageEvents.apiKeyId,
      keyName: apiKeys.name,
      provider: usageEvents.provider,
      model: usageEvents.model,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      costUsd: usageEvents.costUsd,
      status: usageEvents.status,
      streamed: usageEvents.streamed,
      responseKind: usageEvents.responseKind,
    })
    .from(usageEvents)
    .leftJoin(apiKeys, eq(usageEvents.apiKeyId, apiKeys.id))
    .orderBy(desc(usageEvents.createdAt))
    .limit(limit);
}

// ---- Model eval --------------------------------------------------------------

export interface KeyEval {
  runId: string;
  status: EvalRunStatus;
  championModel: string;
  challengerModel: string;
  judgeModel: string;
  targetN: number;
  capturedN: number;
  judgedN: number;
  summary: EvalSummary | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** Latest eval run per key (keyed by apiKeyId) for the keys list / eval panel. */
export async function getKeyEvals(): Promise<Record<string, KeyEval>> {
  const db = getDb();
  const runs = await db.select().from(evalRuns).orderBy(desc(evalRuns.createdAt));
  const latestByKey = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latestByKey.has(r.apiKeyId)) latestByKey.set(r.apiKeyId, r);

  const ids = [...latestByKey.values()].map((r) => r.id);
  const counts = ids.length
    ? await db
        .select({ runId: evalSamples.runId, n: sql<string>`count(*)` })
        .from(evalSamples)
        .where(and(inArray(evalSamples.runId, ids), eq(evalSamples.status, 'judged')))
        .groupBy(evalSamples.runId)
    : [];
  const judgedByRun = new Map(counts.map((c) => [c.runId, Number(c.n)]));

  const out: Record<string, KeyEval> = {};
  for (const [keyId, r] of latestByKey) {
    out[keyId] = {
      runId: r.id,
      status: r.status,
      championModel: r.championModel,
      challengerModel: r.challengerModel,
      judgeModel: r.judgeModel,
      targetN: r.targetN,
      capturedN: r.capturedN,
      judgedN: judgedByRun.get(r.id) ?? 0,
      summary: (r.summary as EvalSummary | null) ?? null,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
  }
  return out;
}
