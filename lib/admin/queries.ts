/**
 * Read-side queries for the admin console (server components only).
 *
 * Every query takes a Viewer and is scoped via scopeToOwner(): admins see all
 * data, editors see only their own keys' data. The scope is a correlated
 * subquery (empty-set-correct), and `and()`/`.where()` ignore the undefined an
 * admin produces — so admins pass through unfiltered with no branching.
 */
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  apiKeys,
  usageEvents,
  requestLogs,
  evalRuns,
  evalSamples,
  users,
  knowledgebases,
  kbDocuments,
  type KeyParams,
  type EvalRunStatus,
  type EvalSampleStatus,
  type EvalWinner,
  type UserRole,
  type UserStatus,
  type KbDocStatus,
  type UsageStatus,
  type ResponseKind,
} from '@/db/schema';
import type { EvalRecommendation, EvalSummary } from '@/lib/eval/aggregate';
import { evalSpendExpr } from '@/lib/eval/spend';
import { scopeToOwner, type Viewer } from '@/lib/auth/viewer';

export async function getOverview(viewer: Viewer) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  // Requests/tokens/errors are CLIENT metrics (source='proxy'): a judge failure
  // or a cron embed must not inflate the operator's traffic/error cards. Cost
  // splits the same way, with Sophy's own eval/KB spend reported as shadowCost.
  const [agg] = await getDb()
    .select({
      requests: sql<string>`coalesce(count(*) filter (where ${usageEvents.source} = 'proxy'),0)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}) filter (where ${usageEvents.source} = 'proxy'),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}) filter (where ${usageEvents.source} = 'proxy'),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}) filter (where ${usageEvents.source} = 'proxy'),0)`,
      errors: sql<string>`coalesce(count(*) filter (where ${usageEvents.status} <> 'ok' and ${usageEvents.source} = 'proxy'),0)`,
      shadowCost: sql<string>`coalesce(sum(${usageEvents.costUsd}) filter (where ${usageEvents.source} <> 'proxy'),0)`,
    })
    .from(usageEvents)
    .where(and(gte(usageEvents.createdAt, since), scopeToOwner(viewer, usageEvents.apiKeyId)));
  return {
    requests: Number(agg?.requests ?? 0),
    inputTokens: Number(agg?.inputTokens ?? 0),
    outputTokens: Number(agg?.outputTokens ?? 0),
    cost: Number(agg?.cost ?? 0),
    errors: Number(agg?.errors ?? 0),
    /** Sophy-initiated spend in the window: eval challenger/judge + KB embeds. */
    shadowCost: Number(agg?.shadowCost ?? 0),
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
  monthlyCostCapUsd: number | null;
  rpmLimit: number | null;
  logContent: boolean;
  status: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
  knowledgebaseId: string | null;
}

export async function listKeys(viewer: Viewer): Promise<KeyRow[]> {
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
      monthlyCostCapUsd: apiKeys.monthlyCostCapUsd,
      rpmLimit: apiKeys.rpmLimit,
      logContent: apiKeys.logContent,
      status: apiKeys.status,
      ownerUserId: apiKeys.ownerUserId,
      ownerEmail: users.email,
      knowledgebaseId: apiKeys.knowledgebaseId,
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.ownerUserId, users.id))
    .where(viewer.role === 'admin' ? undefined : eq(apiKeys.ownerUserId, viewer.userId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => ({ ...r, outputSchema: r.outputSchema ?? null, ownerEmail: r.ownerEmail ?? null }));
}

/** Filters shared by every usage query (range + optional key/model). */
export interface UsageFilters {
  sinceDays: number;
  keyId?: string;
  model?: string;
}

function usageWhere(viewer: Viewer, f: UsageFilters) {
  const since = new Date(Date.now() - f.sinceDays * 24 * 60 * 60 * 1000);
  const conds = [gte(usageEvents.createdAt, since)];
  if (f.keyId) conds.push(eq(usageEvents.apiKeyId, f.keyId));
  if (f.model) conds.push(eq(usageEvents.model, f.model));
  // Owner scope ANDs with any keyId filter, so a crafted ?key=<other> stays empty.
  return and(...conds, scopeToOwner(viewer, usageEvents.apiKeyId));
}

const tokensExpr = sql`${usageEvents.inputTokens} + ${usageEvents.outputTokens}`;

// Usage-page contract (kept from the old derived eval fold, now enforced
// directly in SQL because every paid call — proxy, eval challenger/judge, KB
// embed — writes its own source-tagged usage_events row at call time):
//   - COST counts every source (the operator's real gateway burn).
//   - REQUESTS and TOKENS count source='proxy' only — a challenger replay or a
//     cron embed is not client traffic.
// The chart's cost/requests/tokens toggle keeps this honest: non-proxy spend
// surfaces under Cost and is absent under the other two.
const isProxy = sql`${usageEvents.source} = 'proxy'`;
const proxyRequestsExpr = sql<string>`coalesce(count(*) filter (where ${isProxy}),0)`;
const proxyTokensExpr = sql<string>`coalesce(sum(${tokensExpr}) filter (where ${isProxy}),0)`;

export async function getUsageSeries(viewer: Viewer, f: UsageFilters) {
  const rows = await getDb()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`,
      requests: proxyRequestsExpr,
      tokens: proxyTokensExpr,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .where(usageWhere(viewer, f))
    .groupBy(sql`date_trunc('day', ${usageEvents.createdAt})`)
    .orderBy(sql`date_trunc('day', ${usageEvents.createdAt})`);
  return rows.map((r) => ({
    day: r.day,
    requests: Number(r.requests),
    tokens: Number(r.tokens),
    cost: Number(r.cost),
  }));
}

export type UsageDimension = 'model' | 'key';

/** One (day, category) cell for the stacked share chart. */
export interface UsageStackRow {
  day: string;
  cat: string;
  requests: number;
  tokens: number;
  cost: number;
}

/**
 * Per-day usage broken down by category — model id or key name — for the
 * stacked share chart. Same range/key/model filters and owner-scoping as the
 * other usage queries. The client ranks categories, buckets the long tail into
 * "Other", and normalizes each day to 100%.
 */
export async function getUsageStacked(
  viewer: Viewer,
  f: UsageFilters,
  dim: UsageDimension,
): Promise<UsageStackRow[]> {
  const day = sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`;
  const dayTrunc = sql`date_trunc('day', ${usageEvents.createdAt})`;
  const agg = {
    requests: proxyRequestsExpr,
    tokens: proxyTokensExpr,
    cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
  };

  const rows =
    dim === 'model'
      ? await getDb()
          .select({ day, cat: usageEvents.model, ...agg })
          .from(usageEvents)
          .where(usageWhere(viewer, f))
          .groupBy(dayTrunc, usageEvents.model)
          .orderBy(dayTrunc)
      : await getDb()
          // Label by key name; fall back to the id for any orphaned event, and
          // a fixed label for keyless rows (kb_ingest runs from the cron).
          // api_key_id is uuid, so cast to text before coalescing with the text name
          // (Postgres rejects coalesce(text, uuid)).
          .select({
            day,
            cat: sql<string>`coalesce(${apiKeys.name}, ${usageEvents.apiKeyId}::text, 'KB ingestion')`,
            ...agg,
          })
          .from(usageEvents)
          .leftJoin(apiKeys, eq(usageEvents.apiKeyId, apiKeys.id))
          .where(usageWhere(viewer, f))
          .groupBy(dayTrunc, usageEvents.apiKeyId, apiKeys.name)
          .orderBy(dayTrunc);

  return rows.map((r) => ({
    day: r.day,
    cat: r.cat ?? 'unknown',
    requests: Number(r.requests),
    tokens: Number(r.tokens),
    cost: Number(r.cost),
  }));
}

export async function getUsageTotals(viewer: Viewer, f: UsageFilters) {
  const [agg] = await getDb()
    .select({
      requests: proxyRequestsExpr,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}) filter (where ${isProxy}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}) filter (where ${isProxy}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .where(usageWhere(viewer, f));
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

export async function getUsageByKey(viewer: Viewer, f: UsageFilters): Promise<UsageBreakdownRow[]> {
  const rows = await getDb()
    .select({
      keyId: usageEvents.apiKeyId,
      keyName: apiKeys.name,
      requests: proxyRequestsExpr,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}) filter (where ${isProxy}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}) filter (where ${isProxy}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .leftJoin(apiKeys, eq(usageEvents.apiKeyId, apiKeys.id))
    .where(usageWhere(viewer, f))
    .groupBy(usageEvents.apiKeyId, apiKeys.name)
    // Cost-first since cost carries eval/kb spend; tokens break ties.
    .orderBy(desc(sql`coalesce(sum(${usageEvents.costUsd}),0)`), desc(sql`sum(${tokensExpr})`));
  return rows.map((r) => ({
    // Named key, truncated id for a deleted key, fixed label for keyless rows
    // (kb_ingest runs from the cron with no owning key).
    label: r.keyName ?? (r.keyId ? `${r.keyId.slice(0, 8)}… (deleted)` : 'KB ingestion'),
    requests: Number(r.requests),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cost: Number(r.cost),
  }));
}

export async function getUsageByModel(viewer: Viewer, f: UsageFilters): Promise<UsageBreakdownRow[]> {
  const rows = await getDb()
    .select({
      model: usageEvents.model,
      requests: proxyRequestsExpr,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}) filter (where ${isProxy}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}) filter (where ${isProxy}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .where(usageWhere(viewer, f))
    .groupBy(usageEvents.model)
    .orderBy(desc(sql`coalesce(sum(${usageEvents.costUsd}),0)`), desc(sql`sum(${tokensExpr})`));
  return rows.map((r) => ({
    label: r.model ?? '—',
    requests: Number(r.requests),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cost: Number(r.cost),
  }));
}

/** Human labels for the source breakdown on the usage page. */
const SOURCE_LABELS: Record<string, string> = {
  proxy: 'Client traffic',
  eval_challenger: 'Eval — challenger replays',
  eval_judge: 'Eval — judge verdicts',
  kb_ingest: 'KB — document ingestion',
  kb_query: 'KB — query embeddings',
};

/**
 * Per-source spend breakdown (client traffic vs Sophy's own eval/KB calls).
 * Unlike the other usage queries this one reports EVERY source's requests and
 * tokens — the whole point of the card is showing where non-client spend goes.
 */
export async function getUsageBySource(
  viewer: Viewer,
  f: UsageFilters,
): Promise<UsageBreakdownRow[]> {
  const rows = await getDb()
    .select({
      source: usageEvents.source,
      requests: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .where(usageWhere(viewer, f))
    .groupBy(usageEvents.source)
    .orderBy(desc(sql`coalesce(sum(${usageEvents.costUsd}),0)`));
  return rows.map((r) => ({
    label: SOURCE_LABELS[r.source] ?? r.source,
    requests: Number(r.requests),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cost: Number(r.cost),
  }));
}

/**
 * Distinct models seen in the last 90 days (scoped) — drives the model filter
 * dropdown. Includes eval challenger/judge models (they now carry cost on the
 * usage page), so an operator can filter to a judge-only model even when it
 * served no client traffic.
 */
export async function listUsedModels(viewer: Viewer): Promise<string[]> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [proxyRows, evalRows] = await Promise.all([
    getDb()
      .selectDistinct({ model: usageEvents.model })
      .from(usageEvents)
      .where(and(gte(usageEvents.createdAt, since), scopeToOwner(viewer, usageEvents.apiKeyId))),
    getDb()
      .selectDistinct({ challenger: evalRuns.challengerModel, judge: evalRuns.judgeModel })
      .from(evalRuns)
      .where(and(gte(evalRuns.createdAt, since), scopeToOwner(viewer, evalRuns.apiKeyId))),
  ]);
  const models = new Set<string>();
  for (const r of proxyRows) if (r.model) models.add(r.model);
  for (const r of evalRows) {
    models.add(r.challenger);
    models.add(r.judge);
  }
  return [...models].sort();
}

export interface LogDetailEvent {
  id: string;
  source: LogSource;
  createdAt: Date;
  /** Null for keyless rows (kb_ingest runs from the cron). */
  apiKeyId: string | null;
  keyName: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  latencyMs: number | null;
  status: UsageStatus;
  streamed: boolean;
  responseKind: ResponseKind | null;
  errorMessage: string | null;
  /** Challenger calls only: the champion model and the eval run id. */
  championModel: string | null;
  evalRunId: string | null;
}
export interface LogDetailContent {
  surface: string | null;
  systemPrompt: string | null;
  request: unknown;
  response: string | null;
}

export async function getLogDetail(
  viewer: Viewer,
  id: string,
): Promise<{ event: LogDetailEvent; content: LogDetailContent | null } | null> {
  const db = getDb();
  // Owner scope ANDs with the id, so an editor requesting another user's event id
  // gets no row (→ the page 404s) rather than someone else's content.
  const [event] = await db
    .select({
      id: usageEvents.id,
      createdAt: usageEvents.createdAt,
      apiKeyId: usageEvents.apiKeyId,
      keyName: apiKeys.name,
      provider: usageEvents.provider,
      model: usageEvents.model,
      rowSource: usageEvents.source,
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
    .where(and(eq(usageEvents.id, id), scopeToOwner(viewer, usageEvents.apiKeyId)))
    .limit(1);
  if (event) {
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
    return {
      event: { ...event, source: logSourceOf(event.rowSource), championModel: null, evalRunId: null },
      content: content ?? null,
    };
  }

  // Not a proxy request — try an eval challenger call (eval_samples row). uuids
  // are random, so an id matches at most one of the two tables.
  const [sample] = await db
    .select({
      id: evalSamples.id,
      createdAt: CHALLENGER_TS,
      apiKeyId: evalRuns.apiKeyId,
      keyName: apiKeys.name,
      model: evalRuns.challengerModel,
      championModel: evalRuns.championModel,
      evalRunId: evalRuns.id,
      costUsd: evalSamples.challengerCostUsd,
      latencyMs: evalSamples.challengerLatencyMs,
      inputTokens: evalSamples.challengerInputTokens,
      outputTokens: evalSamples.challengerOutputTokens,
      sampleStatus: evalSamples.status,
      errorMessage: evalSamples.errorMessage,
      surface: evalSamples.surface,
      systemPrompt: evalSamples.systemPrompt,
      request: evalSamples.request,
      response: evalSamples.challengerOutput,
      structured: evalSamples.structured,
    })
    .from(evalSamples)
    .innerJoin(evalRuns, eq(evalSamples.runId, evalRuns.id))
    .leftJoin(apiKeys, eq(evalRuns.apiKeyId, apiKeys.id))
    // Same gate as the list: only surface samples whose challenger was attempted
    // ('pending' = not yet run → 404 rather than a misleading 'error' detail).
    .where(
      and(
        eq(evalSamples.id, id),
        inArray(evalSamples.status, ['judged', 'failed']),
        scopeToOwner(viewer, evalRuns.apiKeyId),
      ),
    )
    .limit(1);
  if (!sample) return null;
  return {
    event: {
      id: sample.id,
      source: 'challenger',
      createdAt: new Date(sample.createdAt),
      apiKeyId: sample.apiKeyId,
      keyName: sample.keyName,
      provider: null,
      model: sample.model,
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      costUsd: sample.costUsd,
      latencyMs: sample.latencyMs,
      status: sample.sampleStatus === 'judged' ? 'ok' : 'error',
      streamed: false,
      responseKind: sample.structured ? 'structured' : 'text',
      errorMessage: sample.errorMessage,
      championModel: sample.championModel,
      evalRunId: sample.evalRunId,
    },
    content: {
      surface: sample.surface,
      systemPrompt: sample.systemPrompt,
      request: sample.request,
      response: sample.response,
    },
  };
}

/**
 * Where a log row came from: a live proxy request, an eval challenger call
 * (surfaced from eval_samples, which retains judge context and content), an
 * eval judge call, or a KB embedding call (both from source-tagged usage_events).
 */
export type LogSource = 'proxy' | 'challenger' | 'judge' | 'kb';

/** usage_events.source → LogSource for rows surfaced from usage_events. */
function logSourceOf(source: string): LogSource {
  if (source === 'eval_challenger') return 'challenger'; // reachable via detail-by-id
  if (source === 'eval_judge') return 'judge';
  if (source === 'kb_ingest' || source === 'kb_query') return 'kb';
  return 'proxy';
}

export interface LogListRow {
  id: string;
  source: LogSource;
  createdAt: Date;
  /** Null for keyless rows (kb_ingest runs from the cron). */
  apiKeyId: string | null;
  keyName: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  status: UsageStatus;
  streamed: boolean;
  responseKind: ResponseKind | null;
}

// `coalesce(judged_at, created_at)` — when the challenger actually ran (judge
// time), falling back to capture time. Typed as a string: drizzle date-maps
// timestamp *columns* to Date, but a raw `sql` expression comes back as the raw
// driver string, so callers must wrap it in `new Date(...)`.
const CHALLENGER_TS = sql<string>`coalesce(${evalSamples.judgedAt}, ${evalSamples.createdAt})`;

/**
 * Recent request logs. Proxy, judge, and KB rows come from usage_events; eval
 * **challenger** rows come from eval_samples, which carries the judge context
 * and (until purge) the content the detail page renders. usage_events ALSO
 * records every challenger call (source='eval_challenger') for accounting —
 * those rows are excluded here so a challenger isn't listed twice.
 */
export async function getRecentLogs(
  viewer: Viewer,
  limit = 100,
  source?: LogSource,
): Promise<LogListRow[]> {
  const db = getDb();
  const rows: LogListRow[] = [];

  if (source !== 'challenger') {
    // The source filter lives in SQL, BEFORE the LIMIT: post-filtering in JS
    // would let judge/kb rows consume the row budget and under-fill a filtered
    // view (e.g. the Proxy tab showing a handful of rows right after an eval
    // run floods usage_events with judge calls).
    const sourceCond =
      source === 'proxy'
        ? sql`${usageEvents.source} = 'proxy'`
        : source === 'judge'
          ? sql`${usageEvents.source} = 'eval_judge'`
          : source === 'kb'
            ? sql`${usageEvents.source} in ('kb_ingest', 'kb_query')`
            : sql`${usageEvents.source} <> 'eval_challenger'`;
    const fromUsage = await db
      .select({
        id: usageEvents.id,
        createdAt: usageEvents.createdAt,
        apiKeyId: usageEvents.apiKeyId,
        keyName: apiKeys.name,
        model: usageEvents.model,
        rowSource: usageEvents.source,
        inputTokens: usageEvents.inputTokens,
        outputTokens: usageEvents.outputTokens,
        costUsd: usageEvents.costUsd,
        status: usageEvents.status,
        streamed: usageEvents.streamed,
        responseKind: usageEvents.responseKind,
      })
      .from(usageEvents)
      .leftJoin(apiKeys, eq(usageEvents.apiKeyId, apiKeys.id))
      .where(and(sourceCond, scopeToOwner(viewer, usageEvents.apiKeyId)))
      .orderBy(desc(usageEvents.createdAt))
      .limit(limit);
    for (const r of fromUsage) rows.push({ ...r, source: logSourceOf(r.rowSource) });
  }

  if (source === undefined || source === 'challenger') {
    const challenger = await db
      .select({
        id: evalSamples.id,
        createdAt: CHALLENGER_TS,
        apiKeyId: evalRuns.apiKeyId,
        keyName: apiKeys.name,
        model: evalRuns.challengerModel,
        costUsd: evalSamples.challengerCostUsd,
        inputTokens: evalSamples.challengerInputTokens,
        outputTokens: evalSamples.challengerOutputTokens,
        sampleStatus: evalSamples.status,
        structured: evalSamples.structured,
      })
      .from(evalSamples)
      .innerJoin(evalRuns, eq(evalSamples.runId, evalRuns.id))
      .leftJoin(apiKeys, eq(evalRuns.apiKeyId, apiKeys.id))
      // 'judged'/'failed' = the challenger was attempted (pending = not yet run).
      .where(
        and(inArray(evalSamples.status, ['judged', 'failed']), scopeToOwner(viewer, evalRuns.apiKeyId)),
      )
      .orderBy(desc(CHALLENGER_TS))
      .limit(limit);
    for (const r of challenger)
      rows.push({
        id: r.id,
        source: 'challenger',
        createdAt: new Date(r.createdAt),
        apiKeyId: r.apiKeyId,
        keyName: r.keyName,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
        status: r.sampleStatus === 'judged' ? 'ok' : 'error',
        streamed: false,
        responseKind: r.structured ? 'structured' : 'text',
      });
  }

  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return rows.slice(0, limit);
}

// ---- Users (admin-only screen) ----------------------------------------------

export interface AdminUserRow {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  keyCount: number;
}

export async function listUsers(): Promise<AdminUserRow[]> {
  const rows = await getDb()
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      status: users.status,
      createdAt: users.createdAt,
      keyCount: sql<string>`count(${apiKeys.id})`,
    })
    .from(users)
    .leftJoin(apiKeys, eq(apiKeys.ownerUserId, users.id))
    .groupBy(users.id)
    .orderBy(users.createdAt);
  return rows.map((r) => ({ ...r, keyCount: Number(r.keyCount) }));
}

// ---- Model eval --------------------------------------------------------------

export interface EvalJudgment {
  winner: EvalWinner;
  confidence: number;
  reason: string;
  /** true ⇒ the challenger was shown to the judge as "Response A" (for de-blinding the reason). */
  orderSwapped: boolean;
}

export interface KeyEval {
  runId: string;
  status: EvalRunStatus;
  championModel: string;
  challengerModel: string;
  judgeModel: string;
  targetN: number;
  capturedN: number;
  judgedN: number;
  /** Avg cost per task for each model in THIS run (live; null until samples have cost). */
  avgChampionCostUsd: number | null;
  avgChallengerCostUsd: number | null;
  /** Per-sample verdicts so far (most recent first) — shown in the Eval panel. */
  judgments: EvalJudgment[];
  summary: EvalSummary | null;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * Latest eval-run STATUS per key (cheap — no samples, no cost aggregation). The
 * keys table uses this for the "running" dot and to hint the modal's initial
 * view; the full eval body is fetched lazily when the modal opens (getKeyEvals).
 */
export async function getEvalStatuses(viewer: Viewer): Promise<Record<string, EvalRunStatus>> {
  const rows = await getDb()
    .select({ apiKeyId: evalRuns.apiKeyId, status: evalRuns.status })
    .from(evalRuns)
    .where(scopeToOwner(viewer, evalRuns.apiKeyId))
    .orderBy(desc(evalRuns.createdAt));
  const out: Record<string, EvalRunStatus> = {};
  for (const r of rows) if (!(r.apiKeyId in out)) out[r.apiKeyId] = r.status; // first row = latest run
  return out;
}

/**
 * Full eval state per key (judgments, summary, costs). Heavy — loads judged
 * samples — so it's fetched lazily per key when the eval modal opens, not at
 * page render. Pass `onlyKeyId` to scope to a single key.
 */
export async function getKeyEvals(viewer: Viewer, onlyKeyId?: string): Promise<Record<string, KeyEval>> {
  const db = getDb();
  const runs = await db
    .select()
    .from(evalRuns)
    .where(
      and(
        scopeToOwner(viewer, evalRuns.apiKeyId),
        onlyKeyId ? eq(evalRuns.apiKeyId, onlyKeyId) : undefined,
      ),
    )
    .orderBy(desc(evalRuns.createdAt));
  const latestByKey = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latestByKey.has(r.apiKeyId)) latestByKey.set(r.apiKeyId, r);

  const ids = [...latestByKey.values()].map((r) => r.id);
  const sampleRows = ids.length
    ? await db
        .select({
          runId: evalSamples.runId,
          winner: evalSamples.winner,
          confidence: evalSamples.confidence,
          judgeReason: evalSamples.judgeReason,
          orderSwapped: evalSamples.orderSwapped,
        })
        .from(evalSamples)
        .where(and(inArray(evalSamples.runId, ids), eq(evalSamples.status, 'judged')))
        .orderBy(desc(evalSamples.judgedAt))
    : [];
  const judgmentsByRun = new Map<string, EvalJudgment[]>();
  for (const s of sampleRows) {
    const list = judgmentsByRun.get(s.runId) ?? [];
    list.push({
      winner: (s.winner ?? 'tie') as EvalWinner,
      confidence: s.confidence != null ? Number(s.confidence) : 0,
      reason: s.judgeReason ?? '',
      orderSwapped: s.orderSwapped,
    });
    judgmentsByRun.set(s.runId, list);
  }

  // Avg cost per task per side, for each run (live — works while still running,
  // and survives the post-finalize content purge since cost columns are retained).
  const costRows = ids.length
    ? await db
        .select({
          runId: evalSamples.runId,
          avgChampion: sql<string | null>`avg(${evalSamples.championCostUsd})`,
          avgChallenger: sql<string | null>`avg(${evalSamples.challengerCostUsd})`,
        })
        .from(evalSamples)
        // Restrict to judged samples so both averages share one denominator:
        // champion cost is written at capture (pending), challenger cost only at
        // judge time — averaging over all samples would compare different populations.
        .where(and(inArray(evalSamples.runId, ids), eq(evalSamples.status, 'judged')))
        .groupBy(evalSamples.runId)
    : [];
  const costByRun = new Map<string, { champ: number | null; chall: number | null }>();
  for (const c of costRows) {
    costByRun.set(c.runId, {
      champ: c.avgChampion != null ? Number(c.avgChampion) : null,
      chall: c.avgChallenger != null ? Number(c.avgChallenger) : null,
    });
  }

  const out: Record<string, KeyEval> = {};
  for (const [keyId, r] of latestByKey) {
    const judgments = judgmentsByRun.get(r.id) ?? [];
    out[keyId] = {
      runId: r.id,
      status: r.status,
      championModel: r.championModel,
      challengerModel: r.challengerModel,
      judgeModel: r.judgeModel,
      targetN: r.targetN,
      capturedN: r.capturedN,
      judgedN: judgments.length,
      avgChampionCostUsd: costByRun.get(r.id)?.champ ?? null,
      avgChallengerCostUsd: costByRun.get(r.id)?.chall ?? null,
      judgments,
      summary: (r.summary as EvalSummary | null) ?? null,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
  }
  return out;
}

/** One row per eval run — every run ever, newest first (the evals page). */
export interface EvalRunListRow {
  id: string;
  apiKeyId: string;
  /** null ⇒ the key was deleted after the run (no FK — orphan rows are kept). */
  keyName: string | null;
  championModel: string;
  challengerModel: string;
  judgeModel: string;
  targetN: number;
  capturedN: number;
  judgedN: number;
  failedN: number;
  status: EvalRunStatus;
  /** From the frozen summary — completed runs only. */
  recommendation: EvalRecommendation | null;
  headline: string | null;
  challengerWinRate: number | null;
  /** Challenger + judge spend: frozen at run end, live aggregate while running
   *  (and for runs that ended before the frozen column existed). */
  evalCostUsd: number | null;
  createdAt: Date;
  /** End of the run — set on completion AND on cancel. */
  completedAt: Date | null;
}

/**
 * Every eval run, current and historical, with per-run sample tallies and eval
 * spend. Unlike getKeyEvals (latest run per key, for the keys-page modal) this
 * returns ALL runs. Unbounded like listKeys — runs are operator-initiated, so
 * the table grows with admin activity, not traffic.
 */
export async function listEvalRuns(viewer: Viewer): Promise<EvalRunListRow[]> {
  const db = getDb();
  const runs = await db
    .select({
      id: evalRuns.id,
      apiKeyId: evalRuns.apiKeyId,
      keyName: apiKeys.name,
      championModel: evalRuns.championModel,
      challengerModel: evalRuns.challengerModel,
      judgeModel: evalRuns.judgeModel,
      targetN: evalRuns.targetN,
      capturedN: evalRuns.capturedN,
      status: evalRuns.status,
      summary: evalRuns.summary,
      evalCostUsd: evalRuns.evalCostUsd,
      createdAt: evalRuns.createdAt,
      completedAt: evalRuns.completedAt,
    })
    .from(evalRuns)
    .leftJoin(apiKeys, eq(evalRuns.apiKeyId, apiKeys.id))
    .where(scopeToOwner(viewer, evalRuns.apiKeyId))
    .orderBy(desc(evalRuns.createdAt));

  const ids = runs.map((r) => r.id);
  const tallies = ids.length
    ? await db
        .select({
          runId: evalSamples.runId,
          judged: sql<string>`count(*) filter (where ${evalSamples.status} = 'judged')`,
          failed: sql<string>`count(*) filter (where ${evalSamples.status} = 'failed')`,
          spend: evalSpendExpr(),
        })
        .from(evalSamples)
        .where(inArray(evalSamples.runId, ids))
        .groupBy(evalSamples.runId)
    : [];
  const tallyByRun = new Map(tallies.map((t) => [t.runId, t]));

  return runs.map((r) => {
    const t = tallyByRun.get(r.id);
    const summary = (r.summary as EvalSummary | null) ?? null;
    return {
      id: r.id,
      apiKeyId: r.apiKeyId,
      keyName: r.keyName,
      championModel: r.championModel,
      challengerModel: r.challengerModel,
      judgeModel: r.judgeModel,
      targetN: r.targetN,
      capturedN: r.capturedN,
      judgedN: t ? Number(t.judged) : 0,
      failedN: t ? Number(t.failed) : 0,
      status: r.status,
      recommendation: summary?.recommendation ?? null,
      headline: summary?.headline ?? null,
      challengerWinRate: summary?.challengerWinRate ?? null,
      // Frozen-at-end value first; live aggregate for running runs and for
      // runs that ended before eval_cost_usd existed (cancelled ones: null).
      evalCostUsd:
        r.evalCostUsd != null
          ? Number(r.evalCostUsd)
          : t?.spend != null
            ? Number(t.spend)
            : null,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
  });
}

/** A sample row on the run-detail page. Content columns are purged at run end,
 *  so only verdict/cost/latency/token metadata is carried. */
export interface EvalSampleListRow {
  id: string;
  status: EvalSampleStatus;
  winner: EvalWinner | null;
  confidence: number | null;
  judgeReason: string | null;
  orderSwapped: boolean;
  championCostUsd: number | null;
  championLatencyMs: number | null;
  challengerCostUsd: number | null;
  challengerLatencyMs: number | null;
  judgeCostUsd: number | null;
  errorMessage: string | null;
  /** Refreshed when a conversation continues — NOT first-capture time. */
  createdAt: Date;
  judgedAt: Date | null;
}

export interface EvalRunDetail {
  id: string;
  apiKeyId: string;
  keyName: string | null;
  championModel: string;
  challengerModel: string;
  judgeModel: string;
  targetN: number;
  capturedN: number;
  status: EvalRunStatus;
  summary: EvalSummary | null;
  createdAt: Date;
  completedAt: Date | null;
  emailedAt: Date | null;
  /** All of the run's samples, newest activity first (≤ targetN ≤ 1000 rows).
   *  Cancelled runs have none — their samples are hard-deleted. */
  samples: EvalSampleListRow[];
  judgedN: number;
  failedN: number;
  pendingN: number;
  /** Challenger + judge spend for this run. */
  evalCostUsd: number | null;
  /** Judged-only denominators, matching getKeyEvals (champion cost exists at
   *  capture, challenger cost only at judge time — averaging over all samples
   *  would compare different populations). */
  avgChampionCostUsd: number | null;
  avgChallengerCostUsd: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One eval run with its full sample history — the /admin/evals/[id] page. */
export async function getEvalRunDetail(viewer: Viewer, id: string): Promise<EvalRunDetail | null> {
  // A crafted non-UUID path param would otherwise throw a Postgres uuid-cast
  // error (22P02) and render the error boundary; treat it as not-found instead.
  if (!UUID_RE.test(id)) return null;
  const db = getDb();
  // Owner scope ANDs with the id, so an editor requesting another user's run id
  // gets no row (→ the page 404s) rather than someone else's eval.
  const [run] = await db
    .select({
      id: evalRuns.id,
      apiKeyId: evalRuns.apiKeyId,
      keyName: apiKeys.name,
      championModel: evalRuns.championModel,
      challengerModel: evalRuns.challengerModel,
      judgeModel: evalRuns.judgeModel,
      targetN: evalRuns.targetN,
      capturedN: evalRuns.capturedN,
      status: evalRuns.status,
      summary: evalRuns.summary,
      evalCostUsd: evalRuns.evalCostUsd,
      createdAt: evalRuns.createdAt,
      completedAt: evalRuns.completedAt,
      emailedAt: evalRuns.emailedAt,
    })
    .from(evalRuns)
    .leftJoin(apiKeys, eq(evalRuns.apiKeyId, apiKeys.id))
    .where(and(eq(evalRuns.id, id), scopeToOwner(viewer, evalRuns.apiKeyId)))
    .limit(1);
  if (!run) return null;

  const sampleRows = await db
    .select({
      id: evalSamples.id,
      status: evalSamples.status,
      winner: evalSamples.winner,
      confidence: evalSamples.confidence,
      judgeReason: evalSamples.judgeReason,
      orderSwapped: evalSamples.orderSwapped,
      championCostUsd: evalSamples.championCostUsd,
      championLatencyMs: evalSamples.championLatencyMs,
      challengerCostUsd: evalSamples.challengerCostUsd,
      challengerLatencyMs: evalSamples.challengerLatencyMs,
      judgeCostUsd: evalSamples.judgeCostUsd,
      errorMessage: evalSamples.errorMessage,
      createdAt: evalSamples.createdAt,
      judgedAt: evalSamples.judgedAt,
    })
    .from(evalSamples)
    .where(eq(evalSamples.runId, id))
    .orderBy(desc(CHALLENGER_TS));

  const samples: EvalSampleListRow[] = sampleRows.map((s) => ({
    ...s,
    confidence: s.confidence != null ? Number(s.confidence) : null,
    championCostUsd: s.championCostUsd != null ? Number(s.championCostUsd) : null,
    challengerCostUsd: s.challengerCostUsd != null ? Number(s.challengerCostUsd) : null,
    judgeCostUsd: s.judgeCostUsd != null ? Number(s.judgeCostUsd) : null,
  }));

  const judged = samples.filter((s) => s.status === 'judged');
  const avg = (values: (number | null)[]): number | null => {
    const nums = values.filter((v): v is number => v != null);
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  };
  // Frozen-at-end spend first; live sum for running runs and pre-column ends.
  const liveSpend = samples.length
    ? samples.reduce((sum, s) => sum + (s.challengerCostUsd ?? 0) + (s.judgeCostUsd ?? 0), 0)
    : null;
  return {
    id: run.id,
    apiKeyId: run.apiKeyId,
    keyName: run.keyName,
    championModel: run.championModel,
    challengerModel: run.challengerModel,
    judgeModel: run.judgeModel,
    targetN: run.targetN,
    capturedN: run.capturedN,
    status: run.status,
    summary: (run.summary as EvalSummary | null) ?? null,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    emailedAt: run.emailedAt,
    samples,
    judgedN: judged.length,
    failedN: samples.filter((s) => s.status === 'failed').length,
    pendingN: samples.filter((s) => s.status === 'pending').length,
    evalCostUsd: run.evalCostUsd != null ? Number(run.evalCostUsd) : liveSpend,
    avgChampionCostUsd: avg(judged.map((s) => s.championCostUsd)),
    avgChallengerCostUsd: avg(judged.map((s) => s.challengerCostUsd)),
  };
}

// ---- Knowledgebases ----------------------------------------------------------

export interface KnowledgebaseRow {
  id: string;
  name: string;
  embeddingModel: string;
  ownerUserId: string | null;
  createdAt: Date;
  documentCount: number;
  attachedKeyCount: number;
}

/**
 * All knowledgebases with their document + attached-key counts. KB management is
 * admin-only in v1 (the page guards it), so this lists everything — no owner
 * scoping. Counts come from separate grouped queries (not joins) to avoid the
 * cartesian inflation two left-joins on the same id would cause.
 */
export async function listKnowledgebases(): Promise<KnowledgebaseRow[]> {
  const db = getDb();
  const kbs = await db
    .select({
      id: knowledgebases.id,
      name: knowledgebases.name,
      embeddingModel: knowledgebases.embeddingModel,
      ownerUserId: knowledgebases.ownerUserId,
      createdAt: knowledgebases.createdAt,
    })
    .from(knowledgebases)
    .orderBy(desc(knowledgebases.createdAt));
  if (kbs.length === 0) return [];

  const docCounts = await db
    .select({ kbId: kbDocuments.kbId, n: sql<string>`count(*)` })
    .from(kbDocuments)
    .groupBy(kbDocuments.kbId);
  const keyCounts = await db
    .select({ kbId: apiKeys.knowledgebaseId, n: sql<string>`count(*)` })
    .from(apiKeys)
    .where(isNotNull(apiKeys.knowledgebaseId))
    .groupBy(apiKeys.knowledgebaseId);

  const docMap = new Map(docCounts.map((r) => [r.kbId, Number(r.n)]));
  const keyMap = new Map(keyCounts.map((r) => [r.kbId, Number(r.n)]));
  return kbs.map((k) => ({
    ...k,
    documentCount: docMap.get(k.id) ?? 0,
    attachedKeyCount: keyMap.get(k.id) ?? 0,
  }));
}

/** Lightweight {id,name} list for the key-form knowledgebase picker. */
export async function listKnowledgebaseOptions(): Promise<{ id: string; name: string }[]> {
  return getDb()
    .select({ id: knowledgebases.id, name: knowledgebases.name })
    .from(knowledgebases)
    .orderBy(knowledgebases.name);
}

export interface KbDocumentRow {
  id: string;
  filename: string;
  status: KbDocStatus;
  chunkCount: number;
  bytes: number | null;
  contentType: string | null;
  errorMessage: string | null;
  createdAt: Date;
  ingestedAt: Date | null;
}

/** Documents in a knowledgebase, newest first. */
export async function listKbDocuments(kbId: string): Promise<KbDocumentRow[]> {
  return getDb()
    .select({
      id: kbDocuments.id,
      filename: kbDocuments.filename,
      status: kbDocuments.status,
      chunkCount: kbDocuments.chunkCount,
      bytes: kbDocuments.bytes,
      contentType: kbDocuments.contentType,
      errorMessage: kbDocuments.errorMessage,
      createdAt: kbDocuments.createdAt,
      ingestedAt: kbDocuments.ingestedAt,
    })
    .from(kbDocuments)
    .where(eq(kbDocuments.kbId, kbId))
    .orderBy(desc(kbDocuments.createdAt));
}
