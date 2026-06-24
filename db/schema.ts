/**
 * Postgres schema (Drizzle) — the durable system of record.
 *
 * Simplified, key-centric model: an API key IS the unit of configuration. Each
 * key carries its own model, system prompt, params, optional output schema, and
 * quota. There are no separate clients / routes / prompts — config is read
 * straight off the key on every request (so admin edits take effect instantly).
 *
 * Hot-path counters (rate limit window, cron lock) are Postgres-backed too —
 * see lib/counters.ts and the rate_counters / locks tables below.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  numeric,
  boolean,
  date,
  vector,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ---- Shared TS types --------------------------------------------------------

export type UsageStatus = 'ok' | 'validation_failed' | 'error';
export type ResponseKind = 'text' | 'structured';
export type KeyStatus = 'active' | 'revoked';

/** Operator-set generation parameters applied to every call on a key. */
export interface KeyParams {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

// ---- Users (operators: admins + editors) -----------------------------------

export type UserRole = 'admin' | 'editor';
export type UserStatus = 'active' | 'inactive';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Unique login identity; always stored lowercased + trimmed. */
    email: text('email').notNull(),
    role: text('role').$type<UserRole>().notNull().default('editor'),
    status: text('status').$type<UserStatus>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

// ---- Magic-link login tokens (passwordless auth) ---------------------------

export const loginTokens = pgTable(
  'login_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    /** Denormalized for audit / generic logging. */
    email: text('email').notNull(),
    /** sha256(rawToken) hex — the raw token lives only in the emailed link. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('login_tokens_hash_idx').on(t.tokenHash),
    index('login_tokens_user_idx').on(t.userId),
  ],
);

// ---- API keys (the whole config) -------------------------------------------

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // Non-secret, indexed for O(1) lookup, e.g. "mw_live_ab12cd34".
    keyPrefix: text('key_prefix').notNull().unique(),
    // HMAC-SHA256(full_key, KEY_HASH_PEPPER), hex-encoded.
    keyHash: text('key_hash').notNull(),
    keyLast4: text('key_last4').notNull(),

    // --- per-key configuration ---
    /** Full AI Gateway model id, e.g. "anthropic/claude-sonnet-4.6". */
    model: text('model').notNull(),
    /** Master/system prompt injected on every request (nullable = none). */
    systemPrompt: text('system_prompt'),
    params: jsonb('params').$type<KeyParams>().notNull().default({}),
    /** Optional JSON schema → structured output for this key. */
    outputSchema: jsonb('output_schema').$type<Record<string, unknown> | null>(),

    // --- quota / limits ---
    /** Monthly spend budget in USD (null = unlimited). Admin-controlled; defaults to $100. */
    monthlyCostCapUsd: numeric('monthly_cost_cap_usd', { precision: 12, scale: 4, mode: 'number' }).default(100),
    rpmLimit: integer('rpm_limit'),

    /** Whether to log inbound/outbound message content for this key's requests. */
    logContent: boolean('log_content').notNull().default(true),

    // --- lifecycle ---
    status: text('status').$type<KeyStatus>().notNull().default('active'),
    /** Owning operator (admin or editor); null = unassigned. Never gates proxy traffic. */
    ownerUserId: uuid('owner_user_id'),
    /** Attached knowledgebase for RAG grounding; null = no KB. References knowledgebases.id. */
    knowledgebaseId: uuid('knowledgebase_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('api_keys_status_idx').on(t.status),
    index('api_keys_owner_idx').on(t.ownerUserId),
    index('api_keys_kb_idx').on(t.knowledgebaseId),
  ],
);

// ---- Usage (append-only facts) ---------------------------------------------

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiKeyId: uuid('api_key_id').notNull(),
    provider: text('provider'),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    latencyMs: integer('latency_ms'),
    status: text('status').$type<UsageStatus>().notNull().default('ok'),
    responseKind: text('response_kind').$type<ResponseKind>(),
    streamed: boolean('streamed').notNull().default(false),
    gatewayRequestId: text('gateway_request_id'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('usage_events_key_time_idx').on(t.apiKeyId, t.createdAt),
    index('usage_events_time_idx').on(t.createdAt),
  ],
);

export const usageRollups = pgTable(
  'usage_rollups',
  {
    apiKeyId: uuid('api_key_id').notNull(),
    periodStart: date('period_start').notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    errors: bigint('errors', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.apiKeyId, t.periodStart] })],
);

// ---- Request logs (inbound/outbound content; per-key, 30-day retention) -----
// Shares its primary key with the corresponding usage_events row so the two
// correlate. Kept separate from usage_events so content can be purged on its own
// retention schedule without losing usage/cost history.

export const requestLogs = pgTable(
  'request_logs',
  {
    id: uuid('id').primaryKey(), // == usage_events.id (app-generated, shared)
    apiKeyId: uuid('api_key_id').notNull(),
    surface: text('surface'), // 'chat' | 'responses'
    systemPrompt: text('system_prompt'),
    request: jsonb('request'), // inbound messages sent to the model
    response: text('response'), // outbound model text
    streamed: boolean('streamed').notNull().default(false),
    status: text('status').$type<UsageStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('request_logs_key_time_idx').on(t.apiKeyId, t.createdAt),
    index('request_logs_time_idx').on(t.createdAt),
  ],
);

// ---- File uploads -----------------------------------------------------------

export const blobUploads = pgTable(
  'blob_uploads',
  {
    pathname: text('pathname').primaryKey(),
    url: text('url').notNull(),
    apiKeyId: uuid('api_key_id').notNull(),
    contentType: text('content_type'),
    size: bigint('size', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('blob_uploads_key_idx').on(t.apiKeyId)],
);

// ---- Hot-path counters (Postgres-backed) -----------------------------------

export const rateCounters = pgTable('rate_counters', {
  bucket: text('bucket').primaryKey(),
  windowStart: bigint('window_start', { mode: 'number' }).notNull(),
  count: integer('count').notNull().default(0),
});

export const locks = pgTable('locks', {
  name: text('name').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// ---- Model eval: champion vs challenger ------------------------------------
// A run shadows the next N live requests on a key: the configured "champion"
// model serves the client as usual, the same input is replayed to a
// "challenger" model, and a blind "judge" model picks the better output. After
// N samples we email a verdict + cost/latency comparison. Content for samples is
// captured here regardless of the key's log_content flag, and purged when the
// run ends.

export type EvalRunStatus = 'running' | 'completed' | 'cancelled' | 'failed';
export type EvalWinner = 'champion' | 'challenger' | 'tie';
export type EvalSampleStatus = 'pending' | 'judged' | 'failed';

/** Global, singleton settings (one row, id='global'). */
export const appSettings = pgTable('app_settings', {
  id: text('id').primaryKey().default('global'),
  /** AI Gateway model id used as the eval judge. */
  judgeModel: text('judge_model').notNull().default('anthropic/claude-opus-4.8'),
  /** Where eval summary emails are sent. */
  notifyEmail: text('notify_email'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiKeyId: uuid('api_key_id').notNull(),
    /** Model snapshots taken at run start (the key's model may change later). */
    championModel: text('champion_model').notNull(),
    challengerModel: text('challenger_model').notNull(),
    judgeModel: text('judge_model').notNull(),
    targetN: integer('target_n').notNull().default(100),
    /** Successful live requests captured so far (atomic trigger counter). */
    capturedN: integer('captured_n').notNull().default(0),
    status: text('status').$type<EvalRunStatus>().notNull().default('running'),
    /** Frozen verdict + aggregates, written at completion. */
    summary: jsonb('summary').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
  },
  (t) => [
    index('eval_runs_key_status_idx').on(t.apiKeyId, t.status),
    // At most one running run per key — enforced atomically at the DB level so the
    // app-level check in startEvalRun can't be raced into two concurrent runs.
    uniqueIndex('eval_runs_one_running_per_key')
      .on(t.apiKeyId)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const evalSamples = pgTable(
  'eval_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    /** The live usage_events row this sample came from (for correlation). */
    usageEventId: uuid('usage_event_id'),
    surface: text('surface'), // 'chat' | 'responses'
    // Resolved input replayed identically to the challenger.
    systemPrompt: text('system_prompt'),
    request: jsonb('request'),
    params: jsonb('params').$type<KeyParams>(),
    structured: boolean('structured').notNull().default(false),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown> | null>(),
    // Champion (captured live).
    championOutput: text('champion_output'),
    championCostUsd: numeric('champion_cost_usd', { precision: 12, scale: 6 }),
    championLatencyMs: integer('champion_latency_ms'),
    // Challenger (produced by the cron processor).
    challengerOutput: text('challenger_output'),
    challengerCostUsd: numeric('challenger_cost_usd', { precision: 12, scale: 6 }),
    challengerLatencyMs: integer('challenger_latency_ms'),
    // Judge.
    judgeCostUsd: numeric('judge_cost_usd', { precision: 12, scale: 6 }),
    winner: text('winner').$type<EvalWinner>(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    judgeReason: text('judge_reason'),
    /** Whether the judge saw challenger as "Response A" (position-bias control). */
    orderSwapped: boolean('order_swapped').notNull().default(false),
    status: text('status').$type<EvalSampleStatus>().notNull().default('pending'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    judgedAt: timestamp('judged_at', { withTimezone: true }),
  },
  (t) => [index('eval_samples_run_status_idx').on(t.runId, t.status)],
);

// ---- Knowledgebases (per-key files-backed RAG) ------------------------------

/** Ingestion lifecycle for an uploaded document. */
export type KbDocStatus = 'pending' | 'ingested' | 'failed';

/**
 * A shared, attachable knowledgebase. A KB owns a set of documents (and their
 * embedded chunks); any number of API keys can point at it via
 * `apiKeys.knowledgebaseId`. The embedding model is fixed per-KB because the
 * chunk vector column has a locked dimension — switching it means re-embedding.
 */
export const knowledgebases = pgTable(
  'knowledgebases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Full gateway embedding model id; dimension is locked to this choice (1536). */
    embeddingModel: text('embedding_model').notNull().default('openai/text-embedding-3-small'),
    /** Owning operator (admin or editor); null = unassigned. Mirrors apiKeys.ownerUserId. */
    ownerUserId: uuid('owner_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('knowledgebases_owner_idx').on(t.ownerUserId)],
);

/** A source file uploaded into a KB; ingested asynchronously by the cron. */
export const kbDocuments = pgTable(
  'kb_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kbId: uuid('kb_id').notNull(),
    filename: text('filename').notNull(),
    // Vercel Blob location (own namespace under kb/<kbId>/…; never swept).
    pathname: text('pathname').notNull(),
    url: text('url').notNull(),
    contentType: text('content_type'),
    bytes: bigint('bytes', { mode: 'number' }),
    status: text('status').$type<KbDocStatus>().notNull().default('pending'),
    chunkCount: integer('chunk_count').notNull().default(0),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }),
  },
  (t) => [index('kb_documents_kb_status_idx').on(t.kbId, t.status)],
);

/**
 * One embedded chunk of a document. `kbId` is denormalized so retrieval can
 * scope to a KB with a single indexed predicate. The HNSW index on `embedding`
 * (cosine ops) backs the `<=>` nearest-neighbour search at query time.
 */
export const kbChunks = pgTable(
  'kb_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kbId: uuid('kb_id').notNull(),
    documentId: uuid('document_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('kb_chunks_kb_idx').on(t.kbId),
    index('kb_chunks_document_idx').on(t.documentId),
    // Approximate nearest-neighbour over cosine distance for retrieval.
    index('kb_chunks_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

// ---- Audit ------------------------------------------------------------------

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actor: text('actor').notNull().default('admin'),
  action: text('action').notNull(),
  target: text('target'),
  before: jsonb('before'),
  after: jsonb('after'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
