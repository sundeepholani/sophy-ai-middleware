'use server';

/**
 * Admin/editor mutations (Server Actions). Each authorizes via lib/auth/viewer
 * (admin everywhere; editors only on keys they own), writes Postgres, and records
 * an audit entry attributed to the acting user. Config lives on the key and is
 * read fresh per request, so there's no cache to bust.
 */
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  apiKeys,
  appSettings,
  auditLog,
  evalRuns,
  evalSamples,
  users,
  knowledgebases,
  type KeyParams,
} from '@/db/schema';
import {
  assertAdmin,
  assertUser,
  assertCanManageKey,
  assertCanManageRun,
  requireViewer,
} from '@/lib/auth/viewer';
import { issueKey, generateKey } from '@/lib/auth/api-key';
import { normalizeOutputSchema } from '@/lib/gateway/schema-normalize';
import { schemaCompileError } from '@/lib/gateway/openai-map';
import { getSettings } from '@/lib/admin/settings';
import { getKeyEvals, type KeyEval } from '@/lib/admin/queries';

async function audit(actor: string, action: string, target: string, after: unknown): Promise<void> {
  await getDb()
    .insert(auditLog)
    .values({ actor, action, target, after: after as object });
}

/** Validate an admin-chosen owner: '' / null → unassigned; otherwise must be a real user. */
async function resolveOwner(ownerUserId: string | null | undefined): Promise<string | null> {
  if (!ownerUserId) return null;
  const [u] = await getDb().select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).limit(1);
  if (!u) throw new Error('Owner user not found');
  return u.id;
}

/**
 * Validate a chosen knowledgebase: '' / null → none; otherwise must be a real KB.
 * v1 decision (intentional): KBs are a SHARED, admin-curated, single-org resource,
 * so any operator who can manage a key may attach ANY KB to it — there is no
 * per-owner KB scoping (the schema carries ownerUserId for a future tightening).
 * If KBs ever become team/tenant-private, gate this to admin or scope by owner.
 */
async function resolveKnowledgebase(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const [kb] = await getDb()
    .select({ id: knowledgebases.id })
    .from(knowledgebases)
    .where(eq(knowledgebases.id, id))
    .limit(1);
  if (!kb) throw new Error('Knowledgebase not found');
  return kb.id;
}

// ---- Global settings (admin-only) -------------------------------------------

export interface SettingsInput {
  judgeModel: string;
  notifyEmail: string | null;
}

export async function updateSettings(input: SettingsInput): Promise<void> {
  const viewer = await assertAdmin();
  const judgeModel = input.judgeModel.trim();
  if (!judgeModel) throw new Error('Judge model is required');
  const notifyEmail = input.notifyEmail?.trim() || null;
  if (notifyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)) {
    throw new Error('Notification email is not a valid address');
  }
  await getDb()
    .insert(appSettings)
    .values({ id: 'global', judgeModel, notifyEmail, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { judgeModel, notifyEmail, updatedAt: new Date() },
    });
  await audit(viewer.email, 'settings.update', 'global', { judgeModel, notifyEmail });
  revalidatePath('/admin/settings');
}

export interface KeyFormInput {
  name: string;
  model: string;
  systemPrompt: string | null;
  params: KeyParams;
  outputSchema: Record<string, unknown> | null;
  /** Admin-only monthly USD budget; null = unlimited. Ignored for editors (forced to the default). */
  monthlyCostCapUsd?: number | null;
  rpmLimit: number | null;
  logContent: boolean;
  /** Admin-only: the key's owner (admin or editor), or null = unassigned. Ignored for editors. */
  ownerUserId?: string | null;
  /** Attached knowledgebase for RAG grounding, or null = none. */
  knowledgebaseId?: string | null;
}

/** New keys default to a $100/month budget unless an admin overrides it. */
const DEFAULT_COST_CAP_USD = 100;

/**
 * Server-side guard mirroring the form's client checks, so a crafted action
 * payload can't write a non-object schema, a non-positive cap/rpm, or an
 * out-of-range param. Throws on the first problem.
 */
function validateKeyInput(input: KeyFormInput): void {
  if (!input.name.trim()) throw new Error('Name is required');
  if (!input.model.trim()) throw new Error('Model is required');

  const { outputSchema, monthlyCostCapUsd, rpmLimit, params } = input;
  if (outputSchema !== null && (typeof outputSchema !== 'object' || Array.isArray(outputSchema))) {
    throw new Error('Output schema must be a JSON object');
  }
  if (rpmLimit !== null && (!Number.isInteger(rpmLimit) || rpmLimit <= 0)) {
    throw new Error('Rate limit must be a positive whole number');
  }
  if (monthlyCostCapUsd != null && (!Number.isFinite(monthlyCostCapUsd) || monthlyCostCapUsd <= 0)) {
    throw new Error('Monthly cost budget must be a positive amount');
  }
  const { temperature, topP, maxOutputTokens } = params;
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
  ) {
    throw new Error('Temperature must be between 0 and 2');
  }
  if (topP !== undefined && (!Number.isFinite(topP) || topP < 0 || topP > 1)) {
    throw new Error('Top P must be between 0 and 1');
  }
  if (
    maxOutputTokens !== undefined &&
    (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0)
  ) {
    throw new Error('Max output tokens must be a positive whole number');
  }
}

/**
 * Canonicalize a key's output schema at save time: unwrap any OpenAI
 * `{name,schema,strict}` envelope and strict-normalize so it works on any model
 * the key may be pointed at (matching the proxy's request-time normalization, so
 * the stored value is what actually runs). Rejects a malformed schema here rather
 * than letting it fail on the first request. Returns the normalized schema.
 */
function normalizedSchemaOrThrow(
  outputSchema: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (outputSchema === null) return null;
  const normalized = normalizeOutputSchema(outputSchema);
  const err = schemaCompileError(normalized);
  if (err) throw new Error(`Output schema is not a valid JSON Schema: ${err}`);
  return normalized;
}

export async function createKey(input: KeyFormInput): Promise<{ fullKey: string }> {
  const viewer = await assertUser();
  validateKeyInput(input);
  // Editors always own what they create; admins choose (defaults to unassigned).
  const ownerUserId =
    viewer.role === 'editor' ? viewer.userId : await resolveOwner(input.ownerUserId ?? null);
  // Budget is admin-controlled; editors always get the default. New keys default to $100
  // when no budget is supplied, but an admin who explicitly sends null means "unlimited"
  // (matching updateKey) — so distinguish "absent" (undefined) from "explicitly null".
  const monthlyCostCapUsd =
    viewer.role === 'editor' || input.monthlyCostCapUsd === undefined
      ? DEFAULT_COST_CAP_USD
      : input.monthlyCostCapUsd;
  const knowledgebaseId = await resolveKnowledgebase(input.knowledgebaseId ?? null);
  const outputSchema = normalizedSchemaOrThrow(input.outputSchema);
  const { fullKey, id } = await issueKey({
    ...input,
    outputSchema,
    ownerUserId,
    monthlyCostCapUsd,
    knowledgebaseId,
  });
  await audit(viewer.email, 'key.create', id, {
    name: input.name,
    model: input.model,
    ownerUserId,
    monthlyCostCapUsd,
  });
  revalidatePath('/admin/keys');
  return { fullKey };
}

export async function updateKey(input: KeyFormInput & { id: string }): Promise<void> {
  const { viewer, ownerUserId: currentOwner } = await assertCanManageKey(input.id);
  validateKeyInput(input);

  // Only admins may reassign ownership; editors' owner is left untouched.
  let newOwner = currentOwner;
  if (viewer.role === 'admin' && input.ownerUserId !== undefined) {
    newOwner = await resolveOwner(input.ownerUserId);
  }

  // Knowledgebase: anyone who can manage the key may attach/detach one. Only
  // change it when the field is present (undefined = leave as-is).
  const kbId =
    input.knowledgebaseId !== undefined ? await resolveKnowledgebase(input.knowledgebaseId) : undefined;

  const outputSchema = normalizedSchemaOrThrow(input.outputSchema);

  // Read the prior KB only when we might change it, so we can audit the change
  // (attaching/detaching a KB changes what data the key can surface).
  let priorKb: string | null = null;
  if (kbId !== undefined) {
    const [row] = await getDb()
      .select({ kb: apiKeys.knowledgebaseId })
      .from(apiKeys)
      .where(eq(apiKeys.id, input.id))
      .limit(1);
    priorKb = row?.kb ?? null;
  }

  await getDb()
    .update(apiKeys)
    .set({
      name: input.name,
      model: input.model,
      systemPrompt: input.systemPrompt,
      params: input.params,
      outputSchema,
      rpmLimit: input.rpmLimit,
      logContent: input.logContent,
      ownerUserId: newOwner,
      ...(kbId !== undefined ? { knowledgebaseId: kbId } : {}),
      // Only admins may change the budget; editors' cap is left untouched.
      ...(viewer.role === 'admin' ? { monthlyCostCapUsd: input.monthlyCostCapUsd ?? null } : {}),
    })
    .where(eq(apiKeys.id, input.id));
  await audit(viewer.email, 'key.update', input.id, { name: input.name, model: input.model });
  if (newOwner !== currentOwner) {
    await audit(viewer.email, 'key.reassign', input.id, { from: currentOwner, to: newOwner });
  }
  if (kbId !== undefined && kbId !== priorKb) {
    await audit(viewer.email, 'key.kb', input.id, { from: priorKb, to: kbId });
  }
  revalidatePath('/admin/keys');
}

export async function revokeKey(id: string): Promise<void> {
  const { viewer } = await assertCanManageKey(id);
  await getDb()
    .update(apiKeys)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(apiKeys.id, id));
  // Revocation is instant: verifyKey() reads `status` fresh on every request.
  await audit(viewer.email, 'key.revoke', id, null);
  revalidatePath('/admin/keys');
}

/**
 * Rotate a key's secret: mint a fresh full key and swap the stored
 * prefix/hash/last4 on the SAME row — so all config, usage history, owner, and
 * any attached knowledgebase are preserved, but the old secret stops working
 * immediately (verifyKey() reads the hash fresh every request; there is no
 * grace window). The new full key is returned once, like issuance. Only active
 * keys can be rotated (rotating a revoked key would silently un-revoke it).
 */
export async function rotateKey(id: string): Promise<{ fullKey: string }> {
  const { viewer, status } = await assertCanManageKey(id);
  if (status !== 'active') throw new Error('Only an active key can be rotated');

  // Retry on the (astronomically rare) key_prefix unique-constraint collision so
  // rotation is self-healing, mirroring startEvalRun's 23505 handling.
  let issued: ReturnType<typeof generateKey> | null = null;
  for (let attempt = 0; attempt < 3 && !issued; attempt++) {
    const gen = generateKey();
    try {
      const res = await getDb()
        .update(apiKeys)
        .set({ keyPrefix: gen.prefix, keyHash: gen.hash, keyLast4: gen.last4 })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.status, 'active')))
        .returning({ id: apiKeys.id });
      if (res.length === 0) break; // revoked/deleted out from under us — don't retry
      issued = gen;
    } catch (e) {
      // Fresh prefix collided with another key — try again with new randomness.
      if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') {
        continue;
      }
      throw e;
    }
  }
  if (!issued) throw new Error('Key not found or not active');

  await audit(viewer.email, 'key.rotate', id, { keyPrefix: issued.prefix, keyLast4: issued.last4 });
  revalidatePath('/admin/keys');
  return { fullKey: issued.fullKey };
}

// ---- Model eval runs --------------------------------------------------------

export interface StartEvalInput {
  apiKeyId: string;
  challengerModel: string;
  targetN: number;
}

/** Clamp a requested sample size to a sane positive whole number (default 100, max 1000). */
function clampTargetN(n: number): number {
  return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 100;
}

/**
 * Create a running eval for one already-authorized key, enforcing the run
 * invariants: active key, challenger differs from the champion, and at most one
 * running eval per key (checked, then backstopped by the partial unique index).
 * Throws with a human-readable reason; shared by the single and bulk actions.
 */
async function insertEvalRun(
  key: { id: string; model: string; status: string },
  challengerModel: string,
  judgeModel: string,
  targetN: number,
): Promise<void> {
  if (key.status !== 'active') throw new Error('Key is not active');
  if (challengerModel === key.model) {
    throw new Error('Challenger must differ from the current model');
  }

  const db = getDb();
  const [active] = await db
    .select({ id: evalRuns.id })
    .from(evalRuns)
    .where(and(eq(evalRuns.apiKeyId, key.id), eq(evalRuns.status, 'running')))
    .limit(1);
  if (active) throw new Error('An eval is already running for this key');

  try {
    await db.insert(evalRuns).values({
      apiKeyId: key.id,
      championModel: key.model,
      challengerModel,
      judgeModel,
      targetN,
      status: 'running',
    });
  } catch (e) {
    // Partial unique index (one running run per key) — lost the race.
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') {
      throw new Error('An eval is already running for this key');
    }
    throw e;
  }
}

export async function startEvalRun(input: StartEvalInput): Promise<void> {
  const { viewer, model, status } = await assertCanManageKey(input.apiKeyId);
  const challengerModel = input.challengerModel.trim();
  if (!challengerModel) throw new Error('Challenger model is required');
  const targetN = clampTargetN(input.targetN);

  const settings = await getSettings();
  await insertEvalRun(
    { id: input.apiKeyId, model, status },
    challengerModel,
    settings.judgeModel,
    targetN,
  );
  await audit(viewer.email, 'eval.start', input.apiKeyId, {
    championModel: model,
    challengerModel,
    judgeModel: settings.judgeModel,
    targetN,
  });
  revalidatePath('/admin/keys');
}

// ---- Bulk key operations -----------------------------------------------------

/**
 * Outcome of a bulk action. Keys the viewer may not manage, or that fail an
 * invariant, are SKIPPED (with the key name and a human-readable reason) rather
 * than failing the whole batch — an operator fixing 20 keys shouldn't lose 19
 * updates because one was revoked out from under them. Only a dead session
 * ('unauthorized') aborts outright.
 */
export interface BulkActionResult {
  done: number;
  skipped: { name: string; reason: string }[];
}

/** Dedupe + sanity-bound the selected ids (the keys table tops out far below this). */
function normalizeBulkIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new Error('No keys selected');
  if (unique.length > 500) throw new Error('Too many keys selected');
  return unique;
}

/**
 * Map a per-key failure to a short reason for the skip report. Only known,
 * operator-meaningful messages pass through — anything unexpected collapses to
 * a generic 'failed', because RETURNED values bypass Next's production masking
 * of thrown Server Action errors (a raw driver error would hand the client the
 * failed SQL text).
 */
const KNOWN_SKIP_REASONS = new Set([
  'Key is not active',
  'Challenger must differ from the current model',
  'An eval is already running for this key',
]);
function skipReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : '';
  if (msg === 'forbidden') return 'you do not manage this key';
  if (msg === 'not_found') return 'key no longer exists';
  return KNOWN_SKIP_REASONS.has(msg) ? msg : 'failed';
}

/**
 * Point several keys at a new model in one go. Authorization is per key (admin
 * or owner), matching the single-key edit; each change is audited individually.
 */
export async function bulkUpdateKeyModel(input: { ids: string[]; model: string }): Promise<BulkActionResult> {
  const model = input.model.trim();
  if (!model) throw new Error('Model is required');
  const ids = normalizeBulkIds(input.ids);

  let done = 0;
  const skipped: BulkActionResult['skipped'] = [];
  for (const id of ids) {
    let name = id.slice(0, 8);
    // Once the UPDATE commits the key counts as done, even if the audit insert
    // then fails — reporting a committed change as "skipped" would be a lie.
    let mutated = false;
    try {
      const key = await assertCanManageKey(id);
      name = key.name;
      if (key.status !== 'active') {
        skipped.push({ name, reason: 'key is not active' });
        continue;
      }
      if (key.model === model) {
        skipped.push({ name, reason: 'already on this model' });
        continue;
      }
      await getDb().update(apiKeys).set({ model }).where(eq(apiKeys.id, id));
      mutated = true;
      done++;
      await audit(key.viewer.email, 'key.model', id, { from: key.model, to: model });
    } catch (e) {
      if (e instanceof Error && e.message === 'unauthorized') throw e;
      if (!mutated) skipped.push({ name, reason: skipReason(e) });
      else console.error(`bulk model change: audit write failed for key ${id}`, e);
    }
  }
  // Revalidate even on an all-skips batch: a skip usually means the client's
  // snapshot has diverged from the DB (revoked elsewhere, eval started…), so
  // this is exactly when the table needs a resync.
  revalidatePath('/admin/keys');
  return { done, skipped };
}

/**
 * Start the same challenger eval on several keys. Each key's CURRENT model is its
 * champion, so one challenger can be raced against a mixed fleet. Per-key
 * invariants (active, challenger differs, no running eval) skip that key only.
 */
export async function bulkStartEvalRuns(input: {
  ids: string[];
  challengerModel: string;
  targetN: number;
}): Promise<BulkActionResult> {
  const challengerModel = input.challengerModel.trim();
  if (!challengerModel) throw new Error('Challenger model is required');
  const targetN = clampTargetN(input.targetN);
  const ids = normalizeBulkIds(input.ids);
  const settings = await getSettings();

  let done = 0;
  const skipped: BulkActionResult['skipped'] = [];
  for (const id of ids) {
    let name = id.slice(0, 8);
    // Once the run row is inserted the eval IS running; a later audit failure
    // must not report it as skipped.
    let started = false;
    try {
      const key = await assertCanManageKey(id);
      name = key.name;
      await insertEvalRun(
        { id, model: key.model, status: key.status },
        challengerModel,
        settings.judgeModel,
        targetN,
      );
      started = true;
      done++;
      await audit(key.viewer.email, 'eval.start', id, {
        championModel: key.model,
        challengerModel,
        judgeModel: settings.judgeModel,
        targetN,
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'unauthorized') throw e;
      if (!started) skipped.push({ name, reason: skipReason(e) });
      else console.error(`bulk eval start: audit write failed for key ${id}`, e);
    }
  }
  // Unconditional for the same reason as bulkUpdateKeyModel: skips signal a
  // stale client snapshot, so resync the table either way.
  revalidatePath('/admin/keys');
  return { done, skipped };
}

export async function cancelEvalRun(runId: string): Promise<void> {
  const { viewer } = await assertCanManageRun(runId);
  const db = getDb();
  const cancelled = await db
    .update(evalRuns)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(and(eq(evalRuns.id, runId), eq(evalRuns.status, 'running')))
    .returning({ id: evalRuns.id });
  // Privacy option A: purge captured content for the abandoned run.
  if (cancelled.length > 0) {
    await db.delete(evalSamples).where(eq(evalSamples.runId, runId));
  }
  await audit(viewer.email, 'eval.cancel', runId, null);
  revalidatePath('/admin/keys');
}

/**
 * Latest eval state for one key. The keys page only carries a page-load snapshot,
 * so the eval modal calls this on open (and while a run is judging) to show
 * judgments the background cron produced since. Owner-scoped via getKeyEvals — a
 * viewer who can't see the key gets null.
 */
export async function refreshKeyEval(apiKeyId: string): Promise<KeyEval | null> {
  const viewer = await requireViewer();
  const all = await getKeyEvals(viewer, apiKeyId);
  return all[apiKeyId] ?? null;
}
