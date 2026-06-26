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
  type EvalWinner,
  type UserRole,
  type UserStatus,
  type KbDocStatus,
  type UsageStatus,
  type ResponseKind,
} from '@/db/schema';
import type { EvalSummary } from '@/lib/eval/aggregate';
import { scopeToOwner, type Viewer } from '@/lib/auth/viewer';

export async function getOverview(viewer: Viewer) {
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
    .where(and(gte(usageEvents.createdAt, since), scopeToOwner(viewer, usageEvents.apiKeyId)));
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

export async function getUsageSeries(viewer: Viewer, f: UsageFilters) {
  const rows = await getDb()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`,
      requests: sql<string>`count(*)`,
      tokens: sql<string>`coalesce(sum(${tokensExpr}),0)`,
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
    requests: sql<string>`count(*)`,
    tokens: sql<string>`coalesce(sum(${tokensExpr}),0)`,
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
          // Label by key name; fall back to the id for any orphaned event.
          // api_key_id is uuid, so cast to text before coalescing with the text name
          // (Postgres rejects coalesce(text, uuid)).
          .select({ day, cat: sql<string>`coalesce(${apiKeys.name}, ${usageEvents.apiKeyId}::text)`, ...agg })
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
      requests: sql<string>`coalesce(count(*),0)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}),0)`,
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
      requests: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .leftJoin(apiKeys, eq(usageEvents.apiKeyId, apiKeys.id))
    .where(usageWhere(viewer, f))
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

export async function getUsageByModel(viewer: Viewer, f: UsageFilters): Promise<UsageBreakdownRow[]> {
  const rows = await getDb()
    .select({
      model: usageEvents.model,
      requests: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}),0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}),0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}),0)`,
    })
    .from(usageEvents)
    .where(usageWhere(viewer, f))
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

/** Distinct models seen in the last 90 days (scoped) — drives the model filter dropdown. */
export async function listUsedModels(viewer: Viewer): Promise<string[]> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .selectDistinct({ model: usageEvents.model })
    .from(usageEvents)
    .where(and(gte(usageEvents.createdAt, since), scopeToOwner(viewer, usageEvents.apiKeyId)))
    .orderBy(usageEvents.model);
  return rows.map((r) => r.model).filter((m): m is string => !!m);
}

export interface LogDetailEvent {
  id: string;
  source: LogSource;
  createdAt: Date;
  apiKeyId: string;
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
      event: { ...event, source: 'proxy', championModel: null, evalRunId: null },
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
      inputTokens: null,
      outputTokens: null,
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

/** A request log row — either a live proxy request or an eval challenger call. */
export type LogSource = 'proxy' | 'challenger';
export interface LogListRow {
  id: string;
  source: LogSource;
  createdAt: Date;
  apiKeyId: string;
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
 * Recent request logs. Proxy requests come from usage_events; eval **challenger**
 * calls come from eval_samples (their cost is shadow cost, deliberately kept out
 * of usage_events / quota / the usage charts). The two sources are fetched
 * separately, merged, and sliced — `source` lets the UI label challenger rows.
 */
export async function getRecentLogs(
  viewer: Viewer,
  limit = 100,
  source?: LogSource,
): Promise<LogListRow[]> {
  const db = getDb();
  const rows: LogListRow[] = [];

  if (source !== 'challenger') {
    const proxy = await db
      .select({
        id: usageEvents.id,
        createdAt: usageEvents.createdAt,
        apiKeyId: usageEvents.apiKeyId,
        keyName: apiKeys.name,
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
      .where(scopeToOwner(viewer, usageEvents.apiKeyId))
      .orderBy(desc(usageEvents.createdAt))
      .limit(limit);
    for (const r of proxy) rows.push({ ...r, source: 'proxy' });
  }

  if (source !== 'proxy') {
    const challenger = await db
      .select({
        id: evalSamples.id,
        createdAt: CHALLENGER_TS,
        apiKeyId: evalRuns.apiKeyId,
        keyName: apiKeys.name,
        model: evalRuns.challengerModel,
        costUsd: evalSamples.challengerCostUsd,
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
        inputTokens: null, // not captured for the challenger replay
        outputTokens: null,
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
