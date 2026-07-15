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

export function isGatewayReady(summary: ProjectGatewaySummary): boolean {
  return summary.isReady;
}

export function projectRoleLabel(role: ProjectRole): string {
  return role === 'admin' ? 'Project Admin' : 'Editor';
}
