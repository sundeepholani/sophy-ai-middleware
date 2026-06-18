/**
 * Read-side queries for the admin console (server components only).
 */
import { desc, gte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { apiKeys, usageEvents, type KeyParams } from '@/db/schema';

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
      status: apiKeys.status,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => ({ ...r, outputSchema: r.outputSchema ?? null }));
}

export async function getUsageSeries() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`,
      requests: sql<string>`count(*)`,
      tokens: sql<string>`coalesce(sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))
    .groupBy(sql`date_trunc('day', ${usageEvents.createdAt})`)
    .orderBy(sql`date_trunc('day', ${usageEvents.createdAt})`);
  return rows.map((r) => ({
    day: r.day,
    requests: Number(r.requests),
    tokens: Number(r.tokens),
    cost: Number(r.cost),
  }));
}

export async function getRecentLogs(limit = 100) {
  return getDb()
    .select({
      id: usageEvents.id,
      createdAt: usageEvents.createdAt,
      apiKeyId: usageEvents.apiKeyId,
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
    .orderBy(desc(usageEvents.createdAt))
    .limit(limit);
}
