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
  foreignKey,
  ForeignKeyBuilder,
  type PgColumn,
  check,
} from 'drizzle-orm/pg-core';

// ---- Shared TS types --------------------------------------------------------

export type UsageStatus = 'ok' | 'validation_failed' | 'error';
// 'assessment' is the /v1/evaluate surface. The internal word differs from the
// wire word on purpose: 'eval'/'evaluation' already names champion-vs-challenger
// model comparison (eval_runs / eval_samples / UsageSource eval_*).
export type ResponseKind =
  | 'text'
  | 'structured'
  | 'image'
  | 'embedding'
  | 'transcription'
  | 'assessment';
export type KeyStatus = 'active' | 'revoked';
/**
 * What kind of gateway call a usage_event records. 'proxy' = the one
 * client-request row. 'transcript_processor' is a second paid model component
 * of that same client request: its tokens/cost count toward client usage and
 * quota, but it never adds another client request. The rest are Sophy's own
 * spend: eval challenger replays / judge verdicts (billed per call —
 * re-judging a continued conversation adds rows rather than overwriting) and
 * knowledgebase embeddings.
 */
export type UsageSource =
  | 'proxy'
  | 'transcript_processor'
  | 'eval_challenger'
  | 'eval_judge'
  | 'kb_ingest'
  | 'kb_query';
export const CLIENT_USAGE_SOURCES = [
  'proxy',
  'transcript_processor',
] as const satisfies readonly UsageSource[];
export type ProjectRole = 'admin' | 'editor';
export type ProjectStatus = 'active' | 'suspended' | 'archived';
export type MembershipStatus = 'active' | 'suspended';
export type GatewayCredentialSource = 'encrypted_api_key' | 'platform_env';
export type GatewayCredentialLifecycle = 'available' | 'replaced' | 'disconnected';
export type GatewayCredentialHealth = 'unchecked' | 'healthy' | 'invalid' | 'billing_attention';

/** Operator-set generation parameters applied to every call on a key. */
export interface KeyParams {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  /**
   * Optional language model used after a transcription completes. It is
   * required when a transcription key has a system prompt, because speech
   * recognition models cannot reliably follow arbitrary instructions such as
   * summarization, translation, redaction, or action-item extraction.
   */
  transcriptProcessorModel?: string;
  /**
   * Agent mode: honor the CLIENT's system prompt (chat LEADING `system`/
   * `developer` messages; responses `instructions` + leading system items) by
   * appending it after the key's own prompt. For agentic SDK flows (e.g.
   * openai-agents) whose instructions are dynamic per request and can't live on
   * the key. Default false — the key exclusively owns the prompt.
   *
   * TRUST REQUIREMENT: enable only for keys used by server-side apps that
   * construct the message array themselves. Client prompts are operator-level;
   * collection is leading-only so transcript-smuggled system messages are not
   * promoted, but the caller still must not forward end-user-authored leading
   * system messages.
   */
  allowClientPrompt?: boolean;
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
    /** Personal landing preference. Authorization still comes from membership. */
    defaultProjectId: uuid('default_project_id'),
    /** Null only for an identity pre-created by a pending invitation. */
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_email_idx').on(t.email),
    // The class constructor accepts a lazy callback and avoids TypeScript's
    // circular inference while retaining this composite FK in Drizzle metadata.
    new ForeignKeyBuilder((): {
      name: string;
      columns: PgColumn[];
      foreignColumns: PgColumn[];
    } => ({
      name: 'users_default_project_membership_fk',
      columns: [t.defaultProjectId, t.id],
      foreignColumns: [projectMemberships.projectId, projectMemberships.userId],
    })).onDelete('restrict'),
    check(
      'users_email_normalized_check',
      sql`${t.email} = lower(btrim(${t.email}))`,
    ),
  ],
);

// ---- Projects (tenant boundary) --------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Stable URL/display identifier. Renaming a project never changes this. */
    slug: text('slug').notNull(),
    createdByUserId: uuid('created_by_user_id'),
    status: text('status').$type<ProjectStatus>().notNull().default('active'),
    /** Atomic pointer to the one credential future work should capture. */
    currentGatewayCredentialId: uuid('current_gateway_credential_id'),
    gatewayCredentialRevision: integer('gateway_credential_revision').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('projects_slug_idx').on(t.slug),
    uniqueIndex('projects_id_current_gateway_idx').on(t.id, t.currentGatewayCredentialId),
    foreignKey({
      name: 'projects_created_by_user_fk',
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    new ForeignKeyBuilder((): {
      name: string;
      columns: PgColumn[];
      foreignColumns: PgColumn[];
    } => ({
      name: 'projects_current_gateway_credential_fk',
      columns: [t.id, t.currentGatewayCredentialId],
      foreignColumns: [projectGatewayCredentials.projectId, projectGatewayCredentials.id],
    })).onDelete('restrict'),
    check(
      'projects_status_check',
      sql`${t.status} in ('active', 'suspended', 'archived')`,
    ),
  ],
);

export const projectMemberships = pgTable(
  'project_memberships',
  {
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').$type<ProjectRole>().notNull(),
    status: text('status').$type<MembershipStatus>().notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_memberships_user_status_idx').on(t.userId, t.status),
    index('project_memberships_project_role_idx').on(t.projectId, t.role, t.status),
    foreignKey({
      name: 'project_memberships_project_fk',
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'project_memberships_user_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    check(
      'project_memberships_role_check',
      sql`${t.role} in ('admin', 'editor')`,
    ),
    check(
      'project_memberships_status_check',
      sql`${t.status} in ('active', 'suspended')`,
    ),
  ],
);

export const projectInvitations = pgTable(
  'project_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    email: text('email').notNull(),
    role: text('role').$type<ProjectRole>().notNull(),
    invitedByUserId: uuid('invited_by_user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('project_invitations_token_idx').on(t.tokenHash),
    uniqueIndex('project_invitations_one_live_idx')
      .on(t.projectId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    index('project_invitations_project_idx').on(t.projectId, t.createdAt),
    foreignKey({
      name: 'project_invitations_project_fk',
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'project_invitations_inviter_fk',
      columns: [t.invitedByUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'project_invitations_acceptor_fk',
      columns: [t.acceptedByUserId],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    check(
      'project_invitations_role_check',
      sql`${t.role} in ('admin', 'editor')`,
    ),
    check(
      'project_invitations_email_normalized_check',
      sql`${t.email} = lower(btrim(${t.email}))`,
    ),
  ],
);

/** Email-bound verification intents for identities that do not exist yet. */
export const authIntents = pgTable(
  'auth_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    purpose: text('purpose').$type<'signup'>().notNull().default('signup'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('auth_intents_token_idx').on(t.tokenHash),
    index('auth_intents_email_idx').on(t.email, t.createdAt),
    check('auth_intents_purpose_check', sql`${t.purpose} = 'signup'`),
    check(
      'auth_intents_email_normalized_check',
      sql`${t.email} = lower(btrim(${t.email}))`,
    ),
  ],
);

export const projectGatewayCredentials = pgTable(
  'project_gateway_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    source: text('source').$type<GatewayCredentialSource>().notNull(),
    lifecycle: text('lifecycle').$type<GatewayCredentialLifecycle>().notNull().default('available'),
    health: text('health').$type<GatewayCredentialHealth>().notNull().default('unchecked'),
    encryptedSecret: text('encrypted_secret'),
    encryptionNonce: text('encryption_nonce'),
    encryptionTag: text('encryption_tag'),
    encryptionKeyVersion: text('encryption_key_version'),
    secretFingerprint: text('secret_fingerprint'),
    secretLastFour: text('secret_last_four'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastFailureCode: text('last_failure_code'),
    createdByUserId: uuid('created_by_user_id'),
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('project_gateway_credentials_project_id_idx').on(t.projectId, t.id),
    uniqueIndex('project_gateway_credentials_one_available_idx')
      .on(t.projectId)
      .where(sql`${t.lifecycle} = 'available'`),
    uniqueIndex('project_gateway_credentials_fingerprint_idx')
      .on(t.secretFingerprint)
      .where(sql`${t.lifecycle} = 'available' and ${t.secretFingerprint} is not null`),
    index('project_gateway_credentials_project_created_idx').on(t.projectId, t.createdAt),
    foreignKey({
      name: 'project_gateway_credentials_project_fk',
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'project_gateway_credentials_creator_fk',
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    check(
      'project_gateway_credentials_source_check',
      sql`${t.source} in ('encrypted_api_key', 'platform_env')`,
    ),
    check(
      'project_gateway_credentials_lifecycle_check',
      sql`${t.lifecycle} in ('available', 'replaced', 'disconnected')`,
    ),
    check(
      'project_gateway_credentials_health_check',
      sql`${t.health} in ('unchecked', 'healthy', 'invalid', 'billing_attention')`,
    ),
    check(
      'project_gateway_credentials_platform_scope_check',
      sql`${t.source} <> 'platform_env' or ${t.projectId} = '57c16e84-0317-4db5-9282-d25f1d25fb0a'::uuid`,
    ),
    check(
      'project_gateway_credentials_envelope_check',
      sql`(
        ${t.source} = 'platform_env'
        and ${t.encryptedSecret} is null
        and ${t.encryptionNonce} is null
        and ${t.encryptionTag} is null
        and ${t.encryptionKeyVersion} is null
        and ${t.secretFingerprint} is null
        and ${t.createdByUserId} is null
      ) or (
        ${t.source} = 'encrypted_api_key'
        and ${t.encryptionKeyVersion} is not null
        and ${t.secretFingerprint} is not null
        and ${t.createdByUserId} is not null
        and (
          (
            ${t.lifecycle} = 'available'
            and ${t.encryptedSecret} is not null
            and ${t.encryptionNonce} is not null
            and ${t.encryptionTag} is not null
          ) or (
            ${t.lifecycle} in ('replaced', 'disconnected')
            and ${t.encryptedSecret} is null
            and ${t.encryptionNonce} is null
            and ${t.encryptionTag} is null
          )
        )
      )`,
    ),
  ],
);

export const projectSettings = pgTable(
  'project_settings',
  {
    projectId: uuid('project_id').primaryKey(),
    judgeModel: text('judge_model').notNull().default('anthropic/claude-opus-4.8'),
    notifyEmail: text('notify_email'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'project_settings_project_fk',
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete('cascade'),
  ],
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
    foreignKey({
      name: 'login_tokens_user_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
  ],
);

// ---- Email OTP challenges and independently revocable CLI sessions ---------

export const loginChallenges = pgTable(
  'login_challenges',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    /** HMAC includes challenge id, email and code; the secret stays outside DB. */
    codeHash: text('code_hash').notNull(),
    invitationId: uuid('invitation_id'),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('login_challenges_email_created_idx').on(t.email, t.createdAt),
    index('login_challenges_retention_idx').on(t.createdAt),
    foreignKey({
      name: 'login_challenges_invitation_fk',
      columns: [t.invitationId],
      foreignColumns: [projectInvitations.id],
    }).onDelete('restrict'),
    check('login_challenges_attempts_check', sql`${t.attempts} between 0 and 5`),
    check('login_challenges_email_check', sql`${t.email} = lower(btrim(${t.email}))`),
  ],
);

export const cliSessions = pgTable(
  'cli_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('cli_sessions_token_idx').on(t.tokenHash),
    index('cli_sessions_user_idx').on(t.userId),
    index('cli_sessions_expiry_idx').on(t.expiresAt),
    index('cli_sessions_revoked_idx').on(t.revokedAt).where(sql`${t.revokedAt} is not null`),
    foreignKey({
      name: 'cli_sessions_user_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
  ],
);

// ---- API keys (the whole config) -------------------------------------------

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
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
    uniqueIndex('api_keys_project_id_idx').on(t.projectId, t.id),
    index('api_keys_project_status_idx').on(t.projectId, t.status),
    index('api_keys_status_idx').on(t.status),
    index('api_keys_owner_idx').on(t.ownerUserId),
    index('api_keys_kb_idx').on(t.knowledgebaseId),
    foreignKey({
      name: 'api_keys_project_fk',
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'api_keys_owner_membership_fk',
      columns: [t.projectId, t.ownerUserId],
      foreignColumns: [projectMemberships.projectId, projectMemberships.userId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'api_keys_knowledgebase_fk',
      columns: [t.projectId, t.knowledgebaseId],
      foreignColumns: [knowledgebases.projectId, knowledgebases.id],
    }).onDelete('restrict'),
  ],
);

// ---- Usage (append-only facts) ---------------------------------------------

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    gatewayCredentialId: uuid('gateway_credential_id'),
    /** Null for spend not attributable to a key (kb_ingest runs from the cron). */
    apiKeyId: uuid('api_key_id'),
    /** See UsageSource — proxy + transcript_processor are client-attributable usage. */
    source: text('source').$type<UsageSource>().notNull().default('proxy'),
    provider: text('provider'),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    /** Null means the provider/SDK did not report cache-write usage. */
    cacheWriteTokens: integer('cache_write_tokens'),
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
    uniqueIndex('usage_events_project_id_idx').on(t.projectId, t.id),
    index('usage_events_project_time_idx').on(t.projectId, t.createdAt),
    index('usage_events_gateway_credential_idx').on(t.gatewayCredentialId),
    index('usage_events_key_time_idx').on(t.apiKeyId, t.createdAt),
    index('usage_events_time_idx').on(t.createdAt),
    foreignKey({
      name: 'usage_events_project_fk',
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'usage_events_api_key_fk',
      columns: [t.projectId, t.apiKeyId],
      foreignColumns: [apiKeys.projectId, apiKeys.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'usage_events_gateway_credential_fk',
      columns: [t.projectId, t.gatewayCredentialId],
      foreignColumns: [projectGatewayCredentials.projectId, projectGatewayCredentials.id],
    }).onDelete('restrict'),
  ],
);

export const usageRollups = pgTable(
  'usage_rollups',
  {
    projectId: uuid('project_id').notNull(),
    apiKeyId: uuid('api_key_id').notNull(),
    periodStart: date('period_start').notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    errors: bigint('errors', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.apiKeyId, t.periodStart] }),
    foreignKey({
      name: 'usage_rollups_api_key_fk',
      columns: [t.projectId, t.apiKeyId],
      foreignColumns: [apiKeys.projectId, apiKeys.id],
    }).onDelete('cascade'),
  ],
);

// ---- Request logs (inbound/outbound content; per-key retention) -------------
// Shares its primary key with the corresponding usage_events row so the two
// correlate. Kept separate from usage_events so content can be purged on its own
// retention schedule without losing usage/cost history. Complete image inputs
// are retained for at most seven days; requestAfterImageExpiry is the same
// message history with image sources replaced by placeholders, and replaces
// request when that shorter window ends. Other request content lasts 30 days.

export const requestLogs = pgTable(
  'request_logs',
  {
    id: uuid('id').primaryKey(), // == usage_events.id (app-generated, shared)
    projectId: uuid('project_id').notNull(),
    apiKeyId: uuid('api_key_id').notNull(),
    surface: text('surface'), // 'chat' | 'responses' | 'embedding' | 'transcription' | 'assessment'
    systemPrompt: text('system_prompt'),
    request: jsonb('request'), // inbound messages sent to the model (embedding: the input strings)
    requestAfterImageExpiry: jsonb('request_after_image_expiry'),
    imageInputsExpiresAt: timestamp('image_inputs_expires_at', { withTimezone: true }),
    response: text('response'), // outbound model text (null for embeddings — vectors, not text)
    streamed: boolean('streamed').notNull().default(false),
    status: text('status').$type<UsageStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('request_logs_project_time_idx').on(t.projectId, t.createdAt),
    index('request_logs_key_time_idx').on(t.apiKeyId, t.createdAt),
    index('request_logs_time_idx').on(t.createdAt),
    index('request_logs_image_inputs_expiry_idx').on(t.imageInputsExpiresAt),
    foreignKey({
      name: 'request_logs_usage_event_fk',
      columns: [t.projectId, t.id],
      foreignColumns: [usageEvents.projectId, usageEvents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'request_logs_api_key_fk',
      columns: [t.projectId, t.apiKeyId],
      foreignColumns: [apiKeys.projectId, apiKeys.id],
    }).onDelete('restrict'),
    check(
      'request_logs_image_retention_pair_check',
      sql`(${t.imageInputsExpiresAt} is null and ${t.requestAfterImageExpiry} is null)
          or (${t.imageInputsExpiresAt} is not null and ${t.requestAfterImageExpiry} is not null)`,
    ),
    check(
      'request_logs_image_retention_max_check',
      sql`${t.imageInputsExpiresAt} is null
          or ${t.imageInputsExpiresAt} <= ${t.createdAt} + interval '7 days'`,
    ),
  ],
);

// ---- File uploads -----------------------------------------------------------

export const blobUploads = pgTable(
  'blob_uploads',
  {
    pathname: text('pathname').primaryKey(),
    projectId: uuid('project_id').notNull(),
    url: text('url').notNull(),
    apiKeyId: uuid('api_key_id').notNull(),
    contentType: text('content_type'),
    size: bigint('size', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** 24 hours by default; a content-logged image reference extends this to
     * the matching request's seven-day image-input expiry. */
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .default(sql`now() + interval '24 hours'`)
      .notNull(),
  },
  (t) => [
    index('blob_uploads_project_idx').on(t.projectId),
    index('blob_uploads_key_idx').on(t.apiKeyId),
    index('blob_uploads_expiry_idx').on(t.expiresAt),
    foreignKey({
      name: 'blob_uploads_api_key_fk',
      columns: [t.projectId, t.apiKeyId],
      foreignColumns: [apiKeys.projectId, apiKeys.id],
    }).onDelete('cascade'),
    check('blob_uploads_expiry_check', sql`${t.expiresAt} >= ${t.createdAt}`),
  ],
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
    projectId: uuid('project_id').notNull(),
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
    /**
     * Frozen challenger + judge spend, written when the run ends — completed OR
     * cancelled — so the number survives the cancel-time sample purge (which
     * hard-deletes the rows a live aggregate would sum). Null for runs that
     * ended before this column existed; readers fall back to the live aggregate.
     */
    evalCostUsd: numeric('eval_cost_usd', { precision: 12, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('eval_runs_project_id_idx').on(t.projectId, t.id),
    index('eval_runs_project_status_idx').on(t.projectId, t.status),
    index('eval_runs_key_status_idx').on(t.apiKeyId, t.status),
    // At most one running run per key — enforced atomically at the DB level so the
    // app-level check in startEvalRun can't be raced into two concurrent runs.
    uniqueIndex('eval_runs_one_running_per_key')
      .on(t.apiKeyId)
      .where(sql`${t.status} = 'running'`),
    foreignKey({
      name: 'eval_runs_api_key_fk',
      columns: [t.projectId, t.apiKeyId],
      foreignColumns: [apiKeys.projectId, apiKeys.id],
    }).onDelete('cascade'),
  ],
);

export const evalSamples = pgTable(
  'eval_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
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
    challengerInputTokens: integer('challenger_input_tokens'),
    challengerOutputTokens: integer('challenger_output_tokens'),
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
  (t) => [
    index('eval_samples_project_status_idx').on(t.projectId, t.status),
    index('eval_samples_run_status_idx').on(t.runId, t.status),
    foreignKey({
      name: 'eval_samples_run_fk',
      columns: [t.projectId, t.runId],
      foreignColumns: [evalRuns.projectId, evalRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'eval_samples_usage_event_fk',
      columns: [t.projectId, t.usageEventId],
      foreignColumns: [usageEvents.projectId, usageEvents.id],
    }).onDelete('restrict'),
  ],
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
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    /** Full gateway embedding model id; dimension is locked to this choice (1536). */
    embeddingModel: text('embedding_model').notNull().default('openai/text-embedding-3-small'),
    /** Owning operator (admin or editor); null = unassigned. Mirrors apiKeys.ownerUserId. */
    ownerUserId: uuid('owner_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('knowledgebases_project_id_idx').on(t.projectId, t.id),
    index('knowledgebases_project_idx').on(t.projectId),
    index('knowledgebases_owner_idx').on(t.ownerUserId),
    foreignKey({
      name: 'knowledgebases_project_fk',
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'knowledgebases_owner_membership_fk',
      columns: [t.projectId, t.ownerUserId],
      foreignColumns: [projectMemberships.projectId, projectMemberships.userId],
    }).onDelete('restrict'),
  ],
);

/** A source file uploaded into a KB; ingested asynchronously by the cron. */
export const kbDocuments = pgTable(
  'kb_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
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
  (t) => [
    uniqueIndex('kb_documents_project_id_idx').on(t.projectId, t.id),
    index('kb_documents_project_status_idx').on(t.projectId, t.status),
    index('kb_documents_kb_status_idx').on(t.kbId, t.status),
    foreignKey({
      name: 'kb_documents_knowledgebase_fk',
      columns: [t.projectId, t.kbId],
      foreignColumns: [knowledgebases.projectId, knowledgebases.id],
    }).onDelete('cascade'),
  ],
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
    projectId: uuid('project_id').notNull(),
    kbId: uuid('kb_id').notNull(),
    documentId: uuid('document_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('kb_chunks_project_idx').on(t.projectId),
    index('kb_chunks_kb_idx').on(t.kbId),
    index('kb_chunks_document_idx').on(t.documentId),
    // Approximate nearest-neighbour over cosine distance for retrieval.
    index('kb_chunks_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
    foreignKey({
      name: 'kb_chunks_document_fk',
      columns: [t.projectId, t.documentId],
      foreignColumns: [kbDocuments.projectId, kbDocuments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'kb_chunks_knowledgebase_fk',
      columns: [t.projectId, t.kbId],
      foreignColumns: [knowledgebases.projectId, knowledgebases.id],
    }).onDelete('cascade'),
  ],
);

// ---- Audit ------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    actor: text('actor').notNull().default('admin'),
    action: text('action').notNull(),
    target: text('target'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('audit_log_project_time_idx').on(t.projectId, t.createdAt),
    foreignKey({
      name: 'audit_log_project_fk',
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
  ],
);
