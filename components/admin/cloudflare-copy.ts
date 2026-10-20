/**
 * Console copy for the project's OPTIONAL Cloudflare Workers AI credential (D10, contract §4.3).
 * Pure and client-safe: no React, no server imports. The credential card, the Keys callouts and the
 * bulk model dialog read their strings here; tests/cloudflare-console-copy.test.ts pins them.
 * The connection is optional, so no string here may present it as a required setup step.
 */
import type {
  CloudflareCredentialErrorCode,
  ProjectCloudflareSummary,
  ProjectRole,
} from '@/components/admin/project-types';
import { CLOUDFLARE_NOT_READY } from '@/lib/admin/keys';

/** Returned connect/disconnect codes (CloudflareCredentialActionResult). Exhaustive by type. */
export const CLOUDFLARE_ERROR_COPY: Record<CloudflareCredentialErrorCode, string> = {
  cloudflare_invalid_account_id: 'Account ID must be 32 hexadecimal characters.',
  cloudflare_invalid:
    'Cloudflare rejected that account ID and API token. Use the "Workers AI" token template.',
  cloudflare_unreachable: "Couldn't reach Cloudflare to check the token. Try again.",
  cloudflare_in_use: 'That API token is already connected to another Sophy project.',
  not_found: 'This project is no longer available.',
};

/** A THROWN action error. Production replaces thrown messages with a generic digest message
 *  (Next's error handling), so anything unrecognised gets a fixed fallback, never the raw text. */
export function cloudflareThrownErrorCopy(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'forbidden') return 'Only a Project Admin can manage this connection.';
  if (message === 'unauthorized') return 'Your session expired — sign in again.';
  return "Couldn't update the Cloudflare connection. Try again.";
}

/** Client pre-check mirroring normalizeCloudflareAccountId and the token's non-blank rule. The server
 *  stays authoritative; this only saves a round trip for obvious typos. */
export function cloudflareFormError(accountId: string, apiToken: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(accountId.trim().toLowerCase())) {
    return CLOUDFLARE_ERROR_COPY.cloudflare_invalid_account_id;
  }
  if (!apiToken.trim()) return 'Enter the API token.';
  return null;
}

export const CLOUDFLARE_TOAST = {
  connected: 'Cloudflare Workers AI connected',
  rotated: 'Cloudflare credential rotated',
  disconnected: 'Cloudflare Workers AI disconnected',
} as const;

export interface CloudflareStatusCopy {
  icon: 'connected' | 'attention' | 'optional';
  badge: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  title: string;
  description: string;
}

/** Works on Admin AND redacted Editor summaries: an Editor's health is null, so Editors only ever get
 *  the generic ready / optional / attention wording (no "rejected" or billing detail). */
export function cloudflareStatusCopy(
  summary: Pick<ProjectCloudflareSummary, 'state' | 'isReady' | 'health'>,
): CloudflareStatusCopy {
  if (summary.isReady) {
    return {
      icon: 'connected',
      badge: 'Connected',
      variant: 'default',
      title: 'Cloudflare Workers AI is connected',
      description: "Keys bound to Clef or Clairic models run on this project's Cloudflare account.",
    };
  }
  if (summary.state === 'not_connected') {
    return {
      icon: 'optional',
      badge: 'Optional · Not connected',
      variant: 'outline',
      title: 'Cloudflare Workers AI',
      description:
        "Optional. Connect a Cloudflare account to use the Clef evaluation models and the Clairic extraction model (preview). Keys on other models don't need it.",
    };
  }
  switch (summary.health) {
    case 'invalid':
      return {
        icon: 'attention',
        badge: 'Needs attention',
        variant: 'destructive',
        title: 'Cloudflare credential needs attention',
        description:
          'Cloudflare rejected the stored API token. Clef and Clairic keys fail until a Project Admin rotates it. Other keys are unaffected.',
      };
    case 'billing_attention':
      return {
        icon: 'attention',
        badge: 'Billing attention',
        variant: 'destructive',
        title: 'Cloudflare billing needs attention',
        description:
          'Clef and Clairic keys are paused. Check the Cloudflare account, then rotate the credential if needed.',
      };
    default:
      return {
        icon: 'attention',
        badge: 'Needs attention',
        variant: 'destructive',
        title: 'Cloudflare connection needs attention',
        description:
          'Clef and Clairic keys are paused until a Project Admin restores the connection. Other keys are unaffected.',
      };
  }
}

/** The non-Admin note that replaces the controls. */
export function cloudflareViewerNote(
  state: ProjectCloudflareSummary['state'],
  projectName: string,
): string {
  if (state === 'ready') {
    return `A Project Admin manages the Cloudflare Workers AI connection for ${projectName}.`;
  }
  if (state === 'not_connected') {
    return `Optional. A Project Admin can connect Cloudflare Workers AI to enable Clef and Clairic keys in ${projectName}.`;
  }
  return `A Project Admin needs to check the Cloudflare Workers AI connection for ${projectName}.`;
}

export function cloudflareHealthLabel(health: ProjectCloudflareSummary['health']): string {
  switch (health) {
    case 'healthy':
      return 'Healthy';
    case 'invalid':
      return 'Rejected by Cloudflare';
    case 'billing_attention':
      return 'Billing attention';
    case 'unchecked':
      return 'Not checked yet';
    default:
      return '—';
  }
}

/** last_failure_code is written by normalizeProjectCloudflareError. Admin-only. */
export function cloudflareFailureLabel(code: string | null): string | null {
  if (!code) return null;
  return code === 'cloudflare_authentication_failed' ? 'Cloudflare rejected the API token' : code;
}

/** §4.3 copy for the THROWN key-binding codes, by role. 'Unsupported Cloudflare Workers AI model'
 *  is already user-facing and passes through unchanged. */
export function cloudflareBindingCopy(error: string, role: ProjectRole): string {
  if (error !== CLOUDFLARE_NOT_READY) return error;
  return role === 'admin'
    ? 'Connect Cloudflare Workers AI in Settings before using this model.'
    : 'A Project Admin must connect Cloudflare Workers AI before keys can use this model.';
}

/** Keys-page notice when existing active keys use Workers AI models but the credential is not ready. */
export function cloudflareKeysNotice(count: number, role: ProjectRole): { title: string; body: string } {
  const subject = count === 1 ? '1 active key uses' : `${count} active keys use`;
  const object = count === 1 ? 'it' : 'them';
  return {
    title: 'Cloudflare Workers AI is not ready',
    body:
      role === 'admin'
        ? `${subject} a Cloudflare Workers AI model. Requests to ${object} fail until you connect a healthy Cloudflare credential in Settings.`
        : `${subject} a Cloudflare Workers AI model. Requests to ${object} fail until a Project Admin connects a healthy Cloudflare credential.`,
  };
}
