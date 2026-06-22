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
import { apiKeys, appSettings, auditLog, evalRuns, evalSamples, users, type KeyParams } from '@/db/schema';
import { assertAdmin, assertUser, assertCanManageKey, assertCanManageRun } from '@/lib/auth/viewer';
import { issueKey } from '@/lib/auth/api-key';
import { getSettings } from '@/lib/admin/settings';

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
  monthlyTokenCap: number | null;
  rpmLimit: number | null;
  logContent: boolean;
  /** Admin-only: the key's owner (admin or editor), or null = unassigned. Ignored for editors. */
  ownerUserId?: string | null;
}

/**
 * Server-side guard mirroring the form's client checks, so a crafted action
 * payload can't write a non-object schema, a non-positive cap/rpm, or an
 * out-of-range param. Throws on the first problem.
 */
function validateKeyInput(input: KeyFormInput): void {
  if (!input.name.trim()) throw new Error('Name is required');
  if (!input.model.trim()) throw new Error('Model is required');

  const { outputSchema, monthlyTokenCap, rpmLimit, params } = input;
  if (outputSchema !== null && (typeof outputSchema !== 'object' || Array.isArray(outputSchema))) {
    throw new Error('Output schema must be a JSON object');
  }
  for (const [label, v] of [
    ['Monthly token cap', monthlyTokenCap],
    ['Rate limit', rpmLimit],
  ] as const) {
    if (v !== null && (!Number.isInteger(v) || v <= 0)) {
      throw new Error(`${label} must be a positive whole number`);
    }
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

export async function createKey(input: KeyFormInput): Promise<{ fullKey: string }> {
  const viewer = await assertUser();
  validateKeyInput(input);
  // Editors always own what they create; admins choose (defaults to unassigned).
  const ownerUserId =
    viewer.role === 'editor' ? viewer.userId : await resolveOwner(input.ownerUserId ?? null);
  const { fullKey, id } = await issueKey({ ...input, ownerUserId });
  await audit(viewer.email, 'key.create', id, { name: input.name, model: input.model, ownerUserId });
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

  await getDb()
    .update(apiKeys)
    .set({
      name: input.name,
      model: input.model,
      systemPrompt: input.systemPrompt,
      params: input.params,
      outputSchema: input.outputSchema,
      monthlyTokenCap: input.monthlyTokenCap,
      rpmLimit: input.rpmLimit,
      logContent: input.logContent,
      ownerUserId: newOwner,
    })
    .where(eq(apiKeys.id, input.id));
  await audit(viewer.email, 'key.update', input.id, { name: input.name, model: input.model });
  if (newOwner !== currentOwner) {
    await audit(viewer.email, 'key.reassign', input.id, { from: currentOwner, to: newOwner });
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

// ---- Model eval runs --------------------------------------------------------

export interface StartEvalInput {
  apiKeyId: string;
  challengerModel: string;
  targetN: number;
}

export async function startEvalRun(input: StartEvalInput): Promise<void> {
  const { viewer, model, status } = await assertCanManageKey(input.apiKeyId);
  const challengerModel = input.challengerModel.trim();
  if (!challengerModel) throw new Error('Challenger model is required');
  const targetN =
    Number.isInteger(input.targetN) && input.targetN > 0 ? Math.min(input.targetN, 1000) : 100;

  if (status !== 'active') throw new Error('Key is not active');
  if (challengerModel === model) {
    throw new Error('Challenger must differ from the current model');
  }

  const db = getDb();
  const [active] = await db
    .select({ id: evalRuns.id })
    .from(evalRuns)
    .where(and(eq(evalRuns.apiKeyId, input.apiKeyId), eq(evalRuns.status, 'running')))
    .limit(1);
  if (active) throw new Error('An eval is already running for this key');

  const settings = await getSettings();
  try {
    await db.insert(evalRuns).values({
      apiKeyId: input.apiKeyId,
      championModel: model,
      challengerModel,
      judgeModel: settings.judgeModel,
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
  await audit(viewer.email, 'eval.start', input.apiKeyId, {
    championModel: model,
    challengerModel,
    judgeModel: settings.judgeModel,
    targetN,
  });
  revalidatePath('/admin/keys');
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
