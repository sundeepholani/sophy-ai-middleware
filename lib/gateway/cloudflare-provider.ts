/**
 * Project-scoped Cloudflare Workers AI credential resolution (D1–D3).
 *
 * The only runtime path that turns a project's stored Cloudflare token into a
 * caller. Like resolveProjectGateway it returns an immutable snapshot: a request
 * that started on credential row A keeps charging and attributing row A even if an
 * Admin rotates the project to row B while it is in flight. It NEVER reads
 * project_gateway_credentials, so a Vercel outage or 402 cannot block Clef/Clairic,
 * and there is no platform or env fallback, ever.
 */
import 'server-only';

import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { projectCloudflareCredentials, projects } from '@/db/schema';
import { decryptCloudflareCredential, GatewayCredentialCryptoError } from '@/lib/gateway/credential-crypto';
import { CloudflareModelNotRegisteredError, getCloudflareModel } from '@/lib/gateway/cloudflare-models';
import { cloudflareCredentialFailure } from '@/lib/gateway/cloudflare-call';
import {
  ProjectCloudflareUnavailableError,
  ProjectGatewayUnavailableError,
  type ProjectGatewayUnavailableReason,
} from '@/lib/gateway/project-provider';

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
/** Inferred from one account (D2): normalise to lowercase, require 32 hex characters. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
/** Printable, non-space ASCII only — also blocks header injection. Cloudflare tokens are 40+ chars. */
const API_TOKEN = /^[\x21-\x7e]{1,512}$/;
const VALIDATION_TIMEOUT_MS = 10_000;

/** Trim and lowercase. Null unless the result is exactly 32 hex characters. */
export function normalizeCloudflareAccountId(raw: string): string | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return ACCOUNT_ID.test(value) ? value : null;
}

/** Trim. Null unless 1–512 printable non-space ASCII characters. */
export function normalizeCloudflareApiToken(raw: string): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return API_TOKEN.test(value) ? value : null;
}

export interface CloudflareRunner {
  /** POST `body` for a REGISTERED model; returns the raw Response, the caller maps statuses. */
  run(model: string, body: unknown, signal: AbortSignal): Promise<Response>;
}

/**
 * Eager checks, so a bad stored value fails inside resolveProjectCloudflare's try/catch
 * (→ credential_misconfigured) rather than at first call. The token never leaves the
 * closure (as createExplicitEvaluator, project-provider.ts:143-171). Every URL part is
 * the constant, the validated account id and the frozen registry id — never the
 * caller's string — so a key model like '@cf/../../workers/scripts' cannot steer the
 * path (Node's URL parser normalises '..' segments).
 */
export function createExplicitCloudflareRunner(accountId: string, apiToken: string): CloudflareRunner {
  const account = normalizeCloudflareAccountId(accountId);
  if (!account) throw new GatewayCredentialCryptoError('Cloudflare account id is malformed.');
  const token = normalizeCloudflareApiToken(apiToken);
  if (!token) throw new GatewayCredentialCryptoError('Cloudflare API token is missing or malformed.');
  return Object.freeze({
    async run(model: string, body: unknown, signal: AbortSignal): Promise<Response> {
      const entry = getCloudflareModel(model);
      if (!entry) throw new CloudflareModelNotRegisteredError(model); // rejects before any fetch
      return fetch(`${CLOUDFLARE_API_BASE}/accounts/${account}/ai/run/${entry.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    },
  });
}

export type CloudflareValidationResult = 'ok' | 'invalid' | 'unreachable';

/**
 * D2: one free, non-inference, account-scoped call, made OUTSIDE any transaction. It proves
 * the token works for this account and carries Workers AI permission (401/10000 otherwise,
 * per the critic probe). It cannot prove that a Read-only token may call /ai/run; a runtime
 * 401 or 403+10000 then marks the row invalid (normalizeProjectCloudflareError). Never throws.
 */
export async function validateCloudflareCredential(
  accountId: string,
  apiToken: string,
): Promise<CloudflareValidationResult> {
  // Callers pass normalised values; re-check so a misuse can never reach the URL or header.
  if (normalizeCloudflareAccountId(accountId) !== accountId || normalizeCloudflareApiToken(apiToken) !== apiToken) {
    return 'invalid';
  }
  let res: Response;
  try {
    res = await fetch(
      `${CLOUDFLARE_API_BASE}/accounts/${accountId}/ai/models/search?search=clef&per_page=1`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      },
    );
  } catch {
    return 'unreachable'; // network failure or the 10 s timeout
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    return 'invalid';
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return 'unreachable';
  }
  try {
    const json: unknown = await res.json();
    return typeof json === 'object' && json !== null && (json as { success?: unknown }).success === true
      ? 'ok'
      : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export interface ProjectCloudflareSnapshot {
  readonly projectId: string;
  /** The project_cloudflare_credentials.id that pays for this call and is attributed with it (D7). */
  readonly cloudflareCredentialId: string;
  /** projects.cloudflare_credential_revision at capture time. Diagnostics only. */
  readonly credentialRevision: number;
  /** The validated 32-hex id. Admin-only metadata: never echoed to API clients or put in error objects. */
  readonly accountId: string;
  readonly runner: CloudflareRunner;
}

function unavailable(
  projectId: string,
  reason: ProjectGatewayUnavailableReason,
  cloudflareCredentialId?: string,
  cause?: unknown,
): ProjectCloudflareUnavailableError {
  return new ProjectCloudflareUnavailableError(projectId, reason, cloudflareCredentialId, cause);
}

/** Mirrors resolveProjectGateway (project-provider.ts:210-298) minus the platform_env branch. */
export async function resolveProjectCloudflare(projectId: string): Promise<ProjectCloudflareSnapshot> {
  const [row] = await getDb()
    .select({
      projectStatus: projects.status,
      currentCredentialId: projects.currentCloudflareCredentialId,
      credentialRevision: projects.cloudflareCredentialRevision,
      credentialId: projectCloudflareCredentials.id,
      credentialProjectId: projectCloudflareCredentials.projectId,
      accountId: projectCloudflareCredentials.accountId,
      lifecycle: projectCloudflareCredentials.lifecycle,
      health: projectCloudflareCredentials.health,
      encryptedSecret: projectCloudflareCredentials.encryptedSecret,
      encryptionNonce: projectCloudflareCredentials.encryptionNonce,
      encryptionTag: projectCloudflareCredentials.encryptionTag,
      encryptionKeyVersion: projectCloudflareCredentials.encryptionKeyVersion,
    })
    .from(projects)
    .leftJoin(
      projectCloudflareCredentials,
      and(
        eq(projectCloudflareCredentials.id, projects.currentCloudflareCredentialId),
        eq(projectCloudflareCredentials.projectId, projects.id),
      ),
    )
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row) throw unavailable(projectId, 'project_not_found');
  if (row.projectStatus !== 'active') throw unavailable(projectId, 'project_inactive');
  if (!row.currentCredentialId || !row.credentialId || row.credentialProjectId !== projectId) {
    throw unavailable(projectId, 'credential_missing', row.currentCredentialId ?? undefined);
  }
  if (row.lifecycle !== 'available') throw unavailable(projectId, 'credential_unavailable', row.credentialId);
  if (row.health === 'invalid') throw unavailable(projectId, 'credential_invalid', row.credentialId);
  if (row.health === 'billing_attention') {
    throw unavailable(projectId, 'credential_billing_attention', row.credentialId);
  }
  if (row.health !== 'healthy') throw unavailable(projectId, 'credential_unchecked', row.credentialId);

  try {
    const accountId = normalizeCloudflareAccountId(row.accountId ?? '');
    if (!accountId || accountId !== row.accountId) {
      throw new GatewayCredentialCryptoError('Stored Cloudflare account id is malformed.');
    }
    const apiToken = decryptCloudflareCredential({ projectId, credentialId: row.credentialId, accountId, envelope: row });
    return Object.freeze({
      projectId,
      cloudflareCredentialId: row.credentialId,
      credentialRevision: row.credentialRevision,
      accountId,
      runner: createExplicitCloudflareRunner(accountId, apiToken),
    });
  } catch (cause) {
    if (ProjectGatewayUnavailableError.isInstance(cause)) throw cause;
    throw unavailable(projectId, 'credential_misconfigured', row.credentialId, cause);
  }
}

/**
 * Health normaliser for errors from a call made WITH `snapshot` (never given Vercel errors).
 * Only a Cloudflare 401, or 403 + errors[0].code 10000, is a credential failure; it is written
 * to the Cloudflare row the snapshot captured — compare-and-set on that immutable row id
 * (docs/multi-tenancy-plan.md: a late 401 may annotate only the old row, never its
 * replacement). Everything else (429/3036, 429/3040, other 403s, 5xx, network) returns unchanged.
 */
export async function normalizeProjectCloudflareError(
  snapshot: ProjectCloudflareSnapshot,
  error: unknown,
): Promise<unknown> {
  if (ProjectGatewayUnavailableError.isInstance(error)) return error;
  if (cloudflareCredentialFailure(error) !== 'invalid') return error;

  try {
    await getDb()
      .update(projectCloudflareCredentials)
      .set({ health: 'invalid', lastCheckedAt: new Date(), lastFailureCode: 'cloudflare_authentication_failed' })
      .where(
        and(
          eq(projectCloudflareCredentials.id, snapshot.cloudflareCredentialId),
          eq(projectCloudflareCredentials.projectId, snapshot.projectId),
        ),
      );
  } catch {
    // The client-facing failure must not depend on the observability update.
    console.error('[cloudflare] failed to persist project credential health', {
      projectId: snapshot.projectId,
      cloudflareCredentialId: snapshot.cloudflareCredentialId,
    });
  }
  return unavailable(snapshot.projectId, 'credential_invalid', snapshot.cloudflareCredentialId, error);
}
