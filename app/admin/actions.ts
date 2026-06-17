'use server';

/**
 * Admin mutations (Server Actions). Each one asserts admin auth (defense in
 * depth behind middleware), writes Postgres in a transaction, records an audit
 * entry, invalidates the config cache where routing/prompt state changed, and
 * revalidates the affected pages.
 */
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb } from '@/db/client';
import {
  clients,
  apiKeys,
  routes,
  routeConfigVersions,
  prompts,
  promptVersions,
  quotaPolicies,
  auditLog,
  type RouteParams,
  type RouteParamBounds,
  type RouteMode,
} from '@/db/schema';
import { assertAdmin } from '@/lib/admin/guard';
import { issueKey } from '@/lib/auth/api-key';
import { markRevoked } from '@/lib/redis';
import { invalidateConfigCache } from '@/lib/routing/resolve';

async function audit(
  action: string,
  target: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await getDb()
    .insert(auditLog)
    .values({ actor: 'admin', action, target, before: before as object, after: after as object });
}

// ---- Clients & keys ---------------------------------------------------------

export async function createClient(name: string): Promise<{ id: string }> {
  await assertAdmin();
  const [row] = await getDb().insert(clients).values({ name }).returning({ id: clients.id });
  await audit('client.create', row.id, null, { name });
  revalidatePath('/admin/keys');
  return { id: row.id };
}

export async function createKey(input: {
  clientId: string;
  name: string;
  routes: string[];
}): Promise<{ fullKey: string }> {
  await assertAdmin();
  const scopes = input.routes.length > 0 ? { routes: input.routes } : {};
  const { fullKey, id } = await issueKey({
    clientId: input.clientId,
    name: input.name,
    scopes,
  });
  await audit('key.create', id, null, { name: input.name, scopes });
  revalidatePath('/admin/keys');
  return { fullKey };
}

export async function setQuota(input: {
  keyId: string;
  monthlyTokenCap: number | null;
  rpmLimit: number | null;
}): Promise<void> {
  await assertAdmin();
  await getDb()
    .insert(quotaPolicies)
    .values({
      apiKeyId: input.keyId,
      monthlyTokenCap: input.monthlyTokenCap,
      rpmLimit: input.rpmLimit,
    })
    .onConflictDoUpdate({
      target: quotaPolicies.apiKeyId,
      set: {
        monthlyTokenCap: input.monthlyTokenCap,
        rpmLimit: input.rpmLimit,
        updatedAt: new Date(),
      },
    });
  await audit('key.quota', input.keyId, null, input);
  revalidatePath('/admin/keys');
}

export async function revokeKey(keyId: string): Promise<void> {
  await assertAdmin();
  await getDb()
    .update(apiKeys)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(apiKeys.id, keyId));
  // Instant kill switch — strongly consistent, independent of any cache lag.
  await markRevoked(keyId);
  await audit('key.revoke', keyId, null, null);
  revalidatePath('/admin/keys');
}

// ---- Routes -----------------------------------------------------------------

export async function createRoute(input: {
  clientId: string;
  name: string;
  mode: RouteMode;
  description?: string;
}): Promise<{ id: string }> {
  await assertAdmin();
  const [row] = await getDb()
    .insert(routes)
    .values({
      clientId: input.clientId,
      name: input.name,
      mode: input.mode,
      description: input.description ?? null,
    })
    .returning({ id: routes.id });
  await audit('route.create', row.id, null, input);
  revalidatePath('/admin/routes');
  return { id: row.id };
}

export async function publishRouteConfig(input: {
  routeId: string;
  model: string;
  params: RouteParams;
  paramBounds: RouteParamBounds;
  promptId: string | null;
  outputSchema: Record<string, unknown> | null;
  fallbackModels: string[];
  mode: RouteMode;
}): Promise<void> {
  await assertAdmin();
  const provider = input.model.split('/')[0] ?? 'unknown';
  await getDb().transaction(async (tx) => {
    await tx
      .update(routeConfigVersions)
      .set({ isActive: false })
      .where(eq(routeConfigVersions.routeId, input.routeId));
    await tx.insert(routeConfigVersions).values({
      routeId: input.routeId,
      model: input.model,
      provider,
      params: input.params,
      paramBounds: input.paramBounds,
      promptId: input.promptId,
      outputSchema: input.outputSchema,
      fallbackModels: input.fallbackModels,
      isActive: true,
    });
    await tx.update(routes).set({ mode: input.mode }).where(eq(routes.id, input.routeId));
  });
  await invalidateConfigCache();
  await audit('route.publish', input.routeId, null, input);
  revalidatePath(`/admin/routes/${input.routeId}`);
  revalidatePath('/admin/routes');
}

// ---- Prompts ----------------------------------------------------------------

export async function createPrompt(name: string): Promise<{ id: string }> {
  await assertAdmin();
  const [row] = await getDb().insert(prompts).values({ name }).returning({ id: prompts.id });
  await audit('prompt.create', row.id, null, { name });
  revalidatePath('/admin/prompts');
  return { id: row.id };
}

export async function savePromptDraft(input: {
  promptId: string;
  body: string;
}): Promise<{ versionId: string }> {
  await assertAdmin();
  const bodyHash = createHash('sha256').update(input.body).digest('hex');
  const [row] = await getDb()
    .insert(promptVersions)
    .values({
      promptId: input.promptId,
      body: input.body,
      bodyHash,
      status: 'draft',
      isActive: false,
    })
    .returning({ id: promptVersions.id });
  await audit('prompt.draft', input.promptId, null, { versionId: row.id });
  revalidatePath(`/admin/prompts/${input.promptId}`);
  return { versionId: row.id };
}

export async function publishPromptVersion(input: {
  promptId: string;
  versionId: string;
}): Promise<void> {
  await assertAdmin();
  await getDb().transaction(async (tx) => {
    await tx
      .update(promptVersions)
      .set({ isActive: false })
      .where(eq(promptVersions.promptId, input.promptId));
    await tx
      .update(promptVersions)
      .set({ isActive: true, status: 'published' })
      .where(
        and(
          eq(promptVersions.id, input.versionId),
          eq(promptVersions.promptId, input.promptId),
        ),
      );
  });
  // Active prompt feeds resolved routes — invalidate the hot config cache.
  await invalidateConfigCache();
  await audit('prompt.publish', input.promptId, null, { versionId: input.versionId });
  revalidatePath(`/admin/prompts/${input.promptId}`);
}
