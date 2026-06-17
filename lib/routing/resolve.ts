/**
 * Named-route resolution: {clientId, routeName} -> the active provider/model,
 * params, master prompt, and output schema.
 *
 * Postgres is the source of truth. Reads go through the Vercel Runtime Cache
 * (shared per region, ~ms) tagged 'config'; admin publishes call
 * invalidateConfigCache() which expires the tag so the next read repopulates —
 * giving near-instant propagation with no client change and no redeploy.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getCache } from '@vercel/functions';
import { getDb } from '@/db/client';
import {
  routes,
  routeConfigVersions,
  promptVersions,
  type RouteMode,
  type RouteParams,
  type RouteParamBounds,
  type KeyScopes,
} from '@/db/schema';

export const CONFIG_CACHE_TAG = 'config';
const CONFIG_CACHE_TTL = 300; // seconds; tag invalidation is the primary signal.

export interface ResolvedRoute {
  routeId: string;
  routeName: string;
  mode: RouteMode;
  model: string;
  provider: string;
  params: RouteParams;
  paramBounds: RouteParamBounds;
  outputSchema: Record<string, unknown> | null;
  fallbackModels: string[];
  systemPrompt: string | null;
}

function cacheKey(clientId: string, routeName: string): string {
  return `route:${clientId}:${routeName}`;
}

/** Does this key's scope permit the given route name? */
export function keyAllowsRoute(scopes: KeyScopes, routeName: string): boolean {
  if (!scopes.routes || scopes.routes.length === 0) return true;
  return scopes.routes.includes(routeName);
}

async function loadFromDb(
  clientId: string,
  routeName: string,
): Promise<ResolvedRoute | null> {
  const db = getDb();
  const [route] = await db
    .select()
    .from(routes)
    .where(and(eq(routes.clientId, clientId), eq(routes.name, routeName)))
    .limit(1);
  if (!route) return null;

  const [cfg] = await db
    .select()
    .from(routeConfigVersions)
    .where(
      and(
        eq(routeConfigVersions.routeId, route.id),
        eq(routeConfigVersions.isActive, true),
      ),
    )
    .orderBy(desc(routeConfigVersions.id))
    .limit(1);
  if (!cfg) return null;

  let systemPrompt: string | null = null;
  if (cfg.promptId) {
    const [pv] = await db
      .select({ body: promptVersions.body })
      .from(promptVersions)
      .where(
        and(
          eq(promptVersions.promptId, cfg.promptId),
          eq(promptVersions.isActive, true),
        ),
      )
      .limit(1);
    systemPrompt = pv?.body ?? null;
  }

  return {
    routeId: route.id,
    routeName: route.name,
    mode: route.mode,
    model: cfg.model,
    provider: cfg.provider,
    params: cfg.params,
    paramBounds: cfg.paramBounds,
    outputSchema: cfg.outputSchema ?? null,
    fallbackModels: cfg.fallbackModels ?? [],
    systemPrompt,
  };
}

/** Resolve a route, using the Runtime Cache when available. */
export async function resolveRoute(
  clientId: string,
  routeName: string,
): Promise<ResolvedRoute | null> {
  const key = cacheKey(clientId, routeName);
  try {
    const cache = getCache();
    const cached = (await cache.get(key)) as ResolvedRoute | null;
    if (cached) return cached;
    const fresh = await loadFromDb(clientId, routeName);
    if (fresh) {
      await cache.set(key, fresh, { tags: [CONFIG_CACHE_TAG], ttl: CONFIG_CACHE_TTL });
    }
    return fresh;
  } catch {
    // Cache unavailable (e.g. some local contexts) — fall back to Postgres.
    return loadFromDb(clientId, routeName);
  }
}

/** Expire all cached route configs. Call after any admin publish. */
export async function invalidateConfigCache(): Promise<void> {
  try {
    await getCache().expireTag(CONFIG_CACHE_TAG);
  } catch {
    // Best-effort; TTL bounds staleness if invalidation is unavailable.
  }
}
