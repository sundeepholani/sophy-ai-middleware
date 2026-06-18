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

export async function createKey(input: KeyFormInput): Promise<{ fullKey: string }> {
  await assertAdmin();
  const { fullKey, id } = await issueKey(input);
  await audit('key.create', id, { name: input.name, model: input.model });
  revalidatePath('/admin/keys');
  return { fullKey };
}

export async function updateKey(input: KeyFormInput & { id: string }): Promise<void> {
  await assertAdmin();
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
