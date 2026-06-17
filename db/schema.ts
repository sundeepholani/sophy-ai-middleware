/**
 * Postgres schema (Drizzle) — the durable system of record.
 *
 * Hot-path counters (rate limit, quota window, cron lock) are Postgres-backed
 * too — see lib/counters.ts and the rate_counters / locks tables below.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  bigserial,
  numeric,
  boolean,
  date,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ---- Shared TS types for jsonb columns -------------------------------------

export type RouteMode = 'locked' | 'overridable';
export type PromptStatus = 'draft' | 'published' | 'archived';
export type UsageStatus = 'ok' | 'validation_failed' | 'error';
export type ResponseKind = 'text' | 'structured';
export type KeyStatus = 'active' | 'revoked';

/** Operator-set generation parameters applied to every call on a route. */
export interface RouteParams {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

/** Bounds that clamp (or reject) client-supplied params on overridable routes. */
export interface RouteParamBounds {
  temperature?: { min?: number; max?: number };
  maxOutputTokens?: { max?: number };
  topP?: { min?: number; max?: number };
}

export interface KeyScopes {
  /** Route names this key may call. Empty/absent = all routes for the client. */
  routes?: string[];
}

// ---- Clients & API keys -----------------------------------------------------

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Non-secret, indexed for O(1) lookup, e.g. "mw_live_ab12cd34".
    keyPrefix: text('key_prefix').notNull().unique(),
    // HMAC-SHA256(full_key, KEY_HASH_PEPPER), hex-encoded.
    keyHash: text('key_hash').notNull(),
    keyLast4: text('key_last4').notNull(),
    scopes: jsonb('scopes').$type<KeyScopes>().notNull().default({}),
    status: text('status').$type<KeyStatus>().notNull().default('active'),
    rotatedFrom: uuid('rotated_from'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('api_keys_client_idx').on(t.clientId)],
);

// ---- Prompts (versioned) ----------------------------------------------------

export const prompts = pgTable('prompts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promptId: uuid('prompt_id')
      .notNull()
      .references(() => prompts.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    bodyHash: text('body_hash').notNull(),
    status: text('status').$type<PromptStatus>().notNull().default('draft'),
    isActive: boolean('is_active').notNull().default(false),
    createdBy: text('created_by').notNull().default('admin'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('prompt_versions_prompt_idx').on(t.promptId)],
);

// ---- Routes & versioned config ---------------------------------------------

export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    // The wire "model" string clients send. Unique per client.
    name: text('name').notNull(),
    description: text('description'),
    mode: text('mode').$type<RouteMode>().notNull().default('locked'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('routes_client_name_idx').on(t.clientId, t.name)],
);

export const routeConfigVersions = pgTable(
  'route_config_versions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    routeId: uuid('route_id')
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    // Full AI Gateway model id, e.g. "anthropic/claude-sonnet-4.6".
    model: text('model').notNull(),
    // Denormalized provider slug (model id prefix) for analytics/display.
    provider: text('provider').notNull(),
    params: jsonb('params').$type<RouteParams>().notNull().default({}),
    paramBounds: jsonb('param_bounds').$type<RouteParamBounds>().notNull().default({}),
    promptId: uuid('prompt_id').references(() => prompts.id, { onDelete: 'set null' }),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown> | null>(),
    fallbackModels: jsonb('fallback_models').$type<string[]>().notNull().default([]),
    isActive: boolean('is_active').notNull().default(false),
    createdBy: text('created_by').notNull().default('admin'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('route_config_route_idx').on(t.routeId)],
);

// ---- Usage (append-only facts) ---------------------------------------------

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiKeyId: uuid('api_key_id').notNull(),
    clientId: uuid('client_id').notNull(),
    routeId: uuid('route_id'),
    routeName: text('route_name'),
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

// ---- Policy & audit ---------------------------------------------------------

export const quotaPolicies = pgTable('quota_policies', {
  apiKeyId: uuid('api_key_id').primaryKey(),
  monthlyTokenCap: bigint('monthly_token_cap', { mode: 'number' }),
  monthlyCostCap: numeric('monthly_cost_cap', { precision: 14, scale: 6 }),
  rpmLimit: integer('rpm_limit'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const blobUploads = pgTable(
  'blob_uploads',
  {
    pathname: text('pathname').primaryKey(),
    url: text('url').notNull(),
    apiKeyId: uuid('api_key_id').notNull(),
    clientId: uuid('client_id').notNull(),
    contentType: text('content_type'),
    size: bigint('size', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('blob_uploads_key_idx').on(t.apiKeyId)],
);

// ---- Hot-path counters (Postgres-backed; replaces Redis) -------------------

export const rateCounters = pgTable('rate_counters', {
  bucket: text('bucket').primaryKey(),
  windowStart: bigint('window_start', { mode: 'number' }).notNull(),
  count: integer('count').notNull().default(0),
});

export const locks = pgTable('locks', {
  name: text('name').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actor: text('actor').notNull().default('admin'),
  action: text('action').notNull(),
  target: text('target'),
  before: jsonb('before'),
  after: jsonb('after'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
