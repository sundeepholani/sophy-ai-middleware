/**
 * Read-side queries for the admin console (server components only).
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  clients,
  apiKeys,
  quotaPolicies,
  routes,
  routeConfigVersions,
  prompts,
  promptVersions,
  usageEvents,
} from '@/db/schema';

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
  status: string;
  scopes: { routes?: string[] };
  monthlyTokenCap: number | null;
  rpmLimit: number | null;
}

export async function listClientsWithKeys() {
  const db = getDb();
  const clientRows = await db.select().from(clients).orderBy(desc(clients.createdAt));
  const keyRows = await db
    .select({
      id: apiKeys.id,
      clientId: apiKeys.clientId,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      keyLast4: apiKeys.keyLast4,
      status: apiKeys.status,
      scopes: apiKeys.scopes,
      monthlyTokenCap: quotaPolicies.monthlyTokenCap,
      rpmLimit: quotaPolicies.rpmLimit,
    })
    .from(apiKeys)
    .leftJoin(quotaPolicies, eq(quotaPolicies.apiKeyId, apiKeys.id))
    .orderBy(desc(apiKeys.createdAt));

  return clientRows.map((c) => ({
    ...c,
    keys: keyRows.filter((k) => k.clientId === c.id) as (KeyRow & { clientId: string })[],
  }));
}

export async function listClientsSimple() {
  return getDb()
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .orderBy(clients.name);
}

export async function listRoutes() {
  const db = getDb();
  const routeRows = await db
    .select({
      id: routes.id,
      name: routes.name,
      mode: routes.mode,
      clientId: routes.clientId,
      clientName: clients.name,
    })
    .from(routes)
    .leftJoin(clients, eq(clients.id, routes.clientId))
    .orderBy(desc(routes.createdAt));

  if (routeRows.length === 0) return [];
  const configs = await db
    .select({
      routeId: routeConfigVersions.routeId,
      model: routeConfigVersions.model,
      outputSchema: routeConfigVersions.outputSchema,
    })
    .from(routeConfigVersions)
    .where(
      and(
        inArray(
          routeConfigVersions.routeId,
          routeRows.map((r) => r.id),
        ),
        eq(routeConfigVersions.isActive, true),
      ),
    );
  const byRoute = new Map(configs.map((c) => [c.routeId, c]));
  return routeRows.map((r) => ({
    ...r,
    activeModel: byRoute.get(r.id)?.model ?? null,
    structured: byRoute.get(r.id)?.outputSchema != null,
  }));
}

export async function getRouteDetail(id: string) {
  const db = getDb();
  const [route] = await db.select().from(routes).where(eq(routes.id, id)).limit(1);
  if (!route) return null;
  const [active] = await db
    .select()
    .from(routeConfigVersions)
    .where(and(eq(routeConfigVersions.routeId, id), eq(routeConfigVersions.isActive, true)))
    .orderBy(desc(routeConfigVersions.id))
    .limit(1);
  const promptList = await db
    .select({ id: prompts.id, name: prompts.name })
    .from(prompts)
    .orderBy(prompts.name);
  return { route, active: active ?? null, prompts: promptList };
}

export async function listPrompts() {
  const db = getDb();
  const promptRows = await db.select().from(prompts).orderBy(prompts.name);
  if (promptRows.length === 0) return [];
  const active = await db
    .select({ promptId: promptVersions.promptId })
    .from(promptVersions)
    .where(
      and(
        inArray(
          promptVersions.promptId,
          promptRows.map((p) => p.id),
        ),
        eq(promptVersions.isActive, true),
      ),
    );
  const activeSet = new Set(active.map((a) => a.promptId));
  return promptRows.map((p) => ({ ...p, hasActive: activeSet.has(p.id) }));
}

export async function getPromptDetail(id: string) {
  const db = getDb();
  const [prompt] = await db.select().from(prompts).where(eq(prompts.id, id)).limit(1);
  if (!prompt) return null;
  const versions = await db
    .select()
    .from(promptVersions)
    .where(eq(promptVersions.promptId, id))
    .orderBy(desc(promptVersions.createdAt))
    .limit(50);
  return { prompt, versions };
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
      routeName: usageEvents.routeName,
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
