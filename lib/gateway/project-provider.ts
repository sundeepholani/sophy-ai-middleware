/**
 * Project-scoped AI Gateway provider resolution.
 *
 * This is the only runtime path that turns a project's stored credential into
 * an AI SDK provider. It returns an immutable snapshot: a request that started
 * on credential A keeps charging and attributing credential A even if an admin
 * rotates the project to credential B while that request is in flight.
 */
import 'server-only';

import {
  GatewayAuthenticationError,
  GatewayError,
  createGateway,
  type GatewayCreditsResponse,
  type GatewayProvider,
} from '@ai-sdk/gateway';
import {
  createGateway as createTranscriptionGateway,
  GatewayAuthenticationError as TranscriptionGatewayAuthenticationError,
  GatewayError as TranscriptionGatewayError,
  type GatewayProvider as TranscriptionGatewayProvider,
} from 'ai-gateway-v4';
import { APICallError } from 'ai';
import { APICallError as TranscriptionAPICallError } from 'ai-v7';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { projectGatewayCredentials, projects } from '@/db/schema';
import { env } from '@/lib/env';
import { openAiError } from '@/lib/http/openai';
import { LEGACY_PROJECT_ID } from '@/lib/projects/constants';
import {
  decryptGatewayCredential,
  fingerprintGatewayCredential,
  GatewayCredentialCryptoError,
} from '@/lib/gateway/credential-crypto';

export type ProjectGatewayUnavailableReason =
  | 'project_not_found'
  | 'project_inactive'
  | 'credential_missing'
  | 'credential_unavailable'
  | 'credential_unchecked'
  | 'credential_invalid'
  | 'credential_billing_attention'
  | 'credential_misconfigured';

/** Safe, route-facing 503 for a valid Sophy key whose project cannot make calls. */
export class ProjectGatewayUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'project_gateway_unavailable';

  constructor(
    readonly projectId: string,
    readonly reason: ProjectGatewayUnavailableReason,
    readonly gatewayCredentialId?: string,
    readonly cause?: unknown,
  ) {
    super('This project is not ready to make AI Gateway requests.');
    this.name = 'ProjectGatewayUnavailableError';
  }

  static isInstance(error: unknown): error is ProjectGatewayUnavailableError {
    return (
      error instanceof ProjectGatewayUnavailableError ||
      (typeof error === 'object' &&
        error !== null &&
        (error as { name?: unknown }).name === 'ProjectGatewayUnavailableError' &&
        (error as { code?: unknown }).code === 'project_gateway_unavailable')
    );
  }
}

export interface ProjectGatewaySnapshot {
  readonly projectId: string;
  readonly gatewayCredentialId: string;
  readonly credentialRevision: number;
  readonly source: 'encrypted_api_key' | 'platform_env';
  readonly gateway: GatewayProvider;
  readonly transcriptionGateway: TranscriptionGatewayProvider;
}

function unavailable(
  projectId: string,
  reason: ProjectGatewayUnavailableReason,
  gatewayCredentialId?: string,
  cause?: unknown,
): ProjectGatewayUnavailableError {
  return new ProjectGatewayUnavailableError(projectId, reason, gatewayCredentialId, cause);
}

function normalizeGatewayApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  if (!normalized) {
    throw new GatewayCredentialCryptoError('Gateway credential must not be empty.');
  }
  return normalized;
}

/** Construct the AI 6 provider only after proving the key is present and non-empty. */
export function createExplicitGateway(apiKey: string): GatewayProvider {
  return createGateway({ apiKey: normalizeGatewayApiKey(apiKey) });
}

/** Construct the AI 7 transcription provider with the same explicit credential guard. */
export function createExplicitTranscriptionGateway(
  apiKey: string,
): TranscriptionGatewayProvider {
  return createTranscriptionGateway({ apiKey: normalizeGatewayApiKey(apiKey) });
}

/**
 * Validate a candidate credential before it can become a project's active
 * credential. getCredits is an authenticated, non-generation request and proves
 * the supplied key itself works without relying on a global provider fallback.
 */
export async function validateGatewayCredential(
  apiKey: string,
): Promise<GatewayCreditsResponse> {
  return createExplicitGateway(apiKey).getCredits();
}

/**
 * The migration-only platform credential has no persisted fingerprint because
 * its plaintext never enters Postgres. Derive one at runtime and fail closed if
 * an encrypted credential in another project already owns the same Vercel key.
 * This also catches an operator rotating AI_GATEWAY_API_KEY after migration.
 */
export async function platformGatewayCredentialConflicts(
  projectId: string,
  apiKey: string,
): Promise<boolean> {
  const fingerprint = fingerprintGatewayCredential(apiKey);
  const [conflict] = await getDb()
    .select({ id: projectGatewayCredentials.id })
    .from(projectGatewayCredentials)
    .where(
      and(
        ne(projectGatewayCredentials.projectId, projectId),
        eq(projectGatewayCredentials.lifecycle, 'available'),
        eq(projectGatewayCredentials.secretFingerprint, fingerprint),
      ),
    )
    .limit(1);
  return !!conflict;
}

/** Resolve the project's current credential and capture an immutable provider. */
export async function resolveProjectGateway(projectId: string): Promise<ProjectGatewaySnapshot> {
  const [row] = await getDb()
    .select({
      projectStatus: projects.status,
      currentCredentialId: projects.currentGatewayCredentialId,
      credentialRevision: projects.gatewayCredentialRevision,
      credentialId: projectGatewayCredentials.id,
      credentialProjectId: projectGatewayCredentials.projectId,
      source: projectGatewayCredentials.source,
      lifecycle: projectGatewayCredentials.lifecycle,
      health: projectGatewayCredentials.health,
      encryptedSecret: projectGatewayCredentials.encryptedSecret,
      encryptionNonce: projectGatewayCredentials.encryptionNonce,
      encryptionTag: projectGatewayCredentials.encryptionTag,
      encryptionKeyVersion: projectGatewayCredentials.encryptionKeyVersion,
    })
    .from(projects)
    .leftJoin(
      projectGatewayCredentials,
      and(
        eq(projectGatewayCredentials.id, projects.currentGatewayCredentialId),
        eq(projectGatewayCredentials.projectId, projects.id),
      ),
    )
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row) throw unavailable(projectId, 'project_not_found');
  if (row.projectStatus !== 'active') throw unavailable(projectId, 'project_inactive');
  if (!row.currentCredentialId || !row.credentialId || row.credentialProjectId !== projectId) {
    throw unavailable(projectId, 'credential_missing', row.currentCredentialId ?? undefined);
  }
  if (row.lifecycle !== 'available') {
    throw unavailable(projectId, 'credential_unavailable', row.credentialId);
  }
  if (row.health === 'invalid') {
    throw unavailable(projectId, 'credential_invalid', row.credentialId);
  }
  if (row.health === 'billing_attention') {
    throw unavailable(projectId, 'credential_billing_attention', row.credentialId);
  }
  if (row.health !== 'healthy') {
    throw unavailable(projectId, 'credential_unchecked', row.credentialId);
  }

  let apiKey: string;
  try {
    if (row.source === 'platform_env') {
      // Migration bridge only. It is intentionally impossible for a new tenant
      // to opt into the platform's environment key or the SDK's OIDC fallback.
      if (projectId !== LEGACY_PROJECT_ID) {
        throw new GatewayCredentialCryptoError(
          'platform_env credentials are restricted to the migrated project.',
        );
      }
      const platformKey = env.aiGatewayApiKey();
      if (!platformKey?.trim()) {
        throw new GatewayCredentialCryptoError('Migration gateway credential is unavailable.');
      }
      if (await platformGatewayCredentialConflicts(projectId, platformKey)) {
        throw new GatewayCredentialCryptoError(
          'Migration gateway credential is already assigned to another project.',
        );
      }
      apiKey = platformKey;
    } else if (row.source === 'encrypted_api_key') {
      apiKey = decryptGatewayCredential({
        projectId,
        credentialId: row.credentialId,
        envelope: row,
      });
    } else {
      throw new GatewayCredentialCryptoError('Unsupported gateway credential source.');
    }

    return Object.freeze({
      projectId,
      gatewayCredentialId: row.credentialId,
      credentialRevision: row.credentialRevision,
      source: row.source,
      gateway: createExplicitGateway(apiKey),
      transcriptionGateway: createExplicitTranscriptionGateway(apiKey),
    });
  } catch (cause) {
    if (ProjectGatewayUnavailableError.isInstance(cause)) throw cause;
    throw unavailable(projectId, 'credential_misconfigured', row.credentialId, cause);
  }
}

function statusFromError(error: unknown, seen = new Set<unknown>()): number | undefined {
  if (error == null || seen.has(error)) return undefined;
  seen.add(error);

  if (GatewayAuthenticationError.isInstance(error)) return 401;
  if (GatewayError.isInstance(error)) return error.statusCode;
  if (APICallError.isInstance(error)) return error.statusCode;
  if (TranscriptionGatewayAuthenticationError.isInstance(error)) return 401;
  if (TranscriptionGatewayError.isInstance(error)) return error.statusCode;
  if (TranscriptionAPICallError.isInstance(error)) return error.statusCode;
  if (typeof error !== 'object') return undefined;

  const candidate = error as {
    name?: unknown;
    statusCode?: unknown;
    status?: unknown;
    cause?: unknown;
    lastError?: unknown;
    errors?: unknown;
  };
  // A recognized/plain status wins over a wrapper name. This matters for the
  // isolated Gateway v4 transcription bridge, whose real GatewayError objects
  // retain their status code.
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  if (typeof candidate.status === 'number') return candidate.status;
  // AI SDK deliberately wraps GatewayAuthenticationError before handing it to
  // callers: production uses AISDKError{name:'GatewayError'}, development uses
  // a plain Error{name:'GatewayAuthenticationError'}, and both drop status/cause.
  // This helper only runs with an already-resolved explicit project snapshot,
  // so either wrapper unambiguously means that project's credential failed.
  if (candidate.name === 'GatewayError' || candidate.name === 'GatewayAuthenticationError') {
    return 401;
  }
  const fromCause = statusFromError(candidate.cause, seen);
  if (fromCause !== undefined) return fromCause;
  const fromLast = statusFromError(candidate.lastError, seen);
  if (fromLast !== undefined) return fromLast;
  if (Array.isArray(candidate.errors)) {
    for (const nested of candidate.errors) {
      const status = statusFromError(nested, seen);
      if (status !== undefined) return status;
    }
  }
  return undefined;
}

/** Pure classification used by handlers and focused tests. */
export function projectCredentialFailure(
  error: unknown,
): 'invalid' | 'billing_attention' | null {
  const status = statusFromError(error);
  if (status === 401) return 'invalid';
  if (status === 402) return 'billing_attention';
  return null;
}

/**
 * Convert runtime auth/billing failures into the same typed 503 as resolver
 * failures and mark only the immutable credential row that served this call.
 */
export async function normalizeProjectGatewayError(
  snapshot: ProjectGatewaySnapshot,
  error: unknown,
): Promise<unknown> {
  if (ProjectGatewayUnavailableError.isInstance(error)) return error;
  const failure = projectCredentialFailure(error);
  if (!failure) return error;

  try {
    await getDb()
      .update(projectGatewayCredentials)
      .set({
        health: failure,
        lastCheckedAt: new Date(),
        lastFailureCode: failure === 'invalid' ? 'gateway_authentication_failed' : 'gateway_billing_attention',
      })
      .where(
        and(
          eq(projectGatewayCredentials.id, snapshot.gatewayCredentialId),
          eq(projectGatewayCredentials.projectId, snapshot.projectId),
        ),
      );
  } catch {
    // The client-facing failure must not depend on the observability update.
    console.error('[gateway] failed to persist project credential health', {
      projectId: snapshot.projectId,
      gatewayCredentialId: snapshot.gatewayCredentialId,
      failure,
    });
  }

  return unavailable(
    snapshot.projectId,
    failure === 'invalid' ? 'credential_invalid' : 'credential_billing_attention',
    snapshot.gatewayCredentialId,
    error,
  );
}

/** Route/helper response for the typed valid-key-but-unavailable condition. */
export function projectGatewayUnavailableResponse(error: unknown): Response | null {
  if (!ProjectGatewayUnavailableError.isInstance(error)) return null;
  return openAiError(
    503,
    'api_error',
    'This project is not ready to make AI requests. Ask a project admin to connect or check its Vercel AI Gateway key.',
    { code: error.code },
  );
}
