export type ProjectRole = 'admin' | 'editor';

export interface ProjectOption {
  id: string;
  name: string;
  slug: string;
  role: ProjectRole;
  isDefault: boolean;
}

export interface ProjectGatewaySummary {
  projectId: string;
  state: 'not_connected' | 'ready' | 'attention';
  isReady: boolean;
  credentialId: string | null;
  source: 'encrypted_api_key' | 'platform_env' | null;
  lifecycle: 'available' | 'replaced' | 'disconnected' | null;
  health: 'unchecked' | 'healthy' | 'invalid' | 'billing_attention' | null;
  lastFour: string | null;
  connectedAt: Date | string | null;
  verifiedAt: Date | string | null;
  lastCheckedAt: Date | string | null;
  lastFailureCode: string | null;
}

/** Client-safe Cloudflare Workers AI credential summary (Admin view; Editors get the redacted form). */
export interface ProjectCloudflareSummary {
  projectId: string;
  state: 'not_connected' | 'ready' | 'attention';
  isReady: boolean;
  credentialId: string | null;
  /** Admin-only metadata. */
  accountId: string | null;
  lifecycle: 'available' | 'replaced' | 'disconnected' | null;
  health: 'unchecked' | 'healthy' | 'invalid' | 'billing_attention' | null;
  lastFour: string | null;
  connectedAt: Date | string | null;
  verifiedAt: Date | string | null;
  lastCheckedAt: Date | string | null;
  lastFailureCode: string | null;
}

export type CloudflareCredentialErrorCode =
  | 'cloudflare_invalid_account_id'
  | 'cloudflare_invalid'
  | 'cloudflare_unreachable'
  | 'cloudflare_in_use'
  | 'not_found';

/** Returned (never thrown) by connect/disconnect, so production Server Action masking cannot hide the code. */
export type CloudflareCredentialActionResult =
  | { ok: true }
  | { ok: false; code: CloudflareCredentialErrorCode };

export function isGatewayReady(summary: ProjectGatewaySummary): boolean {
  return summary.isReady;
}

export function projectRoleLabel(role: ProjectRole): string {
  return role === 'admin' ? 'Project Admin' : 'Editor';
}
