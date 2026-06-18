'use server';

/**
 * Admin mutations (Server Actions). Each asserts admin auth (defense in depth
 * behind the proxy gate), writes Postgres, and records an audit entry. Config
 * lives on the key and is read fresh per request, so there's no cache to bust.
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { apiKeys, auditLog, type KeyParams } from '@/db/schema';
import { assertAdmin } from '@/lib/admin/guard';
import { issueKey } from '@/lib/auth/api-key';

async function audit(action: string, target: string, after: unknown): Promise<void> {
  await getDb()
    .insert(auditLog)
    .values({ actor: 'admin', action, target, after: after as object });
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
  await assertAdmin();
  validateKeyInput(input);
  const { fullKey, id } = await issueKey(input);
  await audit('key.create', id, { name: input.name, model: input.model });
  revalidatePath('/admin/keys');
  return { fullKey };
}

export async function updateKey(input: KeyFormInput & { id: string }): Promise<void> {
  await assertAdmin();
  validateKeyInput(input);
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
    })
    .where(eq(apiKeys.id, input.id));
  await audit('key.update', input.id, { name: input.name, model: input.model });
  revalidatePath('/admin/keys');
}

export async function revokeKey(id: string): Promise<void> {
  await assertAdmin();
  await getDb()
    .update(apiKeys)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(apiKeys.id, id));
  // Revocation is instant: verifyKey() reads `status` fresh on every request.
  await audit('key.revoke', id, null);
  revalidatePath('/admin/keys');
}
