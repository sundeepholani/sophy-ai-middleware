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
  index,
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
    monthlyTokenCap: bigint('monthly_token_cap', { mode: 'number' }),
    rpmLimit: integer('rpm_limit'),

    /** Whether to log inbound/outbound message content for this key's requests. */
    logContent: boolean('log_content').notNull().default(true),

    // --- lifecycle ---
    status: text('status').$type<KeyStatus>().notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('api_keys_status_idx').on(t.status)],
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
