import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The project Overview page renders the Cloudflare and Gateway credential cards for Admins AND
 * Editors. Props passed to those client components are serialised into the page's Flight payload,
 * so the page itself must hand Editors only the redacted summaries. The cards are replaced by
 * stubs that capture their props; the real redactProjectCloudflareSummary runs.
 */

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(),
  getOverview: vi.fn(),
  gatewaySummary: vi.fn(),
  cloudflareSummary: vi.fn(),
  cloudflareCard: vi.fn(),
  gatewayCard: vi.fn(),
}));

vi.mock('@/db/client', () => ({ getDb: vi.fn() }));
vi.mock('@/lib/auth/viewer', () => ({ requireProjectViewer: mocks.viewer }));
vi.mock('@/lib/admin/queries', () => ({ getOverview: mocks.getOverview }));
vi.mock('@/lib/projects/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects/repository')>()),
  getProjectGatewaySummary: mocks.gatewaySummary,
  getProjectCloudflareSummary: mocks.cloudflareSummary,
}));
vi.mock('@/app/admin/project-actions', () => ({
  connectProjectCloudflare: vi.fn(),
  connectProjectGateway: vi.fn(),
  disconnectProjectCloudflare: vi.fn(),
  disconnectProjectGateway: vi.fn(),
  setDefaultProject: vi.fn(),
}));
vi.mock('@/components/admin/cloudflare-credential-card', () => ({
  CloudflareCredentialCard: (props: unknown) => {
    mocks.cloudflareCard(props);
    return null;
  },
}));
vi.mock('@/components/admin/gateway-credential-card', () => ({
  GatewayCredentialCard: (props: unknown) => {
    mocks.gatewayCard(props);
    return null;
  },
}));
vi.mock('@/components/admin/make-default-project-button', () => ({ MakeDefaultProjectButton: () => null }));

import ProjectOverviewPage from '@/app/admin/p/[projectId]/page';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const CLOUDFLARE = {
  projectId: PROJECT,
  state: 'attention' as const,
  isReady: false,
  credentialId: '00000000-0000-4000-8000-000000000004',
  accountId: ACCOUNT_ID,
  lifecycle: 'available' as const,
  health: 'invalid' as const,
  lastFour: 'wxyz',
  connectedAt: new Date('2026-10-01T00:00:00Z'),
  verifiedAt: new Date('2026-10-01T00:00:00Z'),
  lastCheckedAt: new Date('2026-10-02T00:00:00Z'),
  lastFailureCode: 'cloudflare_authentication_failed',
};
const GATEWAY = {
  projectId: PROJECT,
  state: 'ready' as const,
  isReady: true,
  credentialId: '00000000-0000-4000-8000-000000000002',
  source: 'encrypted_api_key' as const,
  lifecycle: 'available' as const,
  health: 'healthy' as const,
  lastFour: 'abcd',
  connectedAt: new Date('2026-09-01T00:00:00Z'),
  verifiedAt: new Date('2026-09-01T00:00:00Z'),
  lastCheckedAt: new Date('2026-09-02T00:00:00Z'),
  lastFailureCode: null,
};
/** Admin-only fields both summaries share; Cloudflare adds accountId, the Gateway adds source. */
const ADMIN_ONLY_NULLS = {
  credentialId: null,
  lifecycle: null,
  health: null,
  lastFour: null,
  connectedAt: null,
  verifiedAt: null,
  lastCheckedAt: null,
  lastFailureCode: null,
};

function viewer(role: 'admin' | 'editor') {
  return {
    userId: '00000000-0000-4000-8000-000000000009',
    email: `${role}@example.test`,
    role,
    projectId: PROJECT,
    projectName: 'Acme',
    projectSlug: 'acme',
    projectStatus: 'active',
    defaultProjectId: null,
  };
}

async function render(role: 'admin' | 'editor') {
  mocks.viewer.mockResolvedValue(viewer(role));
  renderToStaticMarkup(await ProjectOverviewPage({ params: Promise.resolve({ projectId: PROJECT }) }));
  expect(mocks.cloudflareCard).toHaveBeenCalledOnce();
  expect(mocks.gatewayCard).toHaveBeenCalledOnce();
  return {
    cloudflare: (mocks.cloudflareCard.mock.calls[0][0] as { summary: unknown }).summary,
    gateway: (mocks.gatewayCard.mock.calls[0][0] as { summary: unknown }).summary,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOverview.mockResolvedValue({
    requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, shadowCost: 0, errors: 0,
  });
  mocks.gatewaySummary.mockResolvedValue(GATEWAY);
  mocks.cloudflareSummary.mockResolvedValue(CLOUDFLARE);
});

describe('project Overview credential redaction', () => {
  it("hands Editors only the Cloudflare card's generic readiness", async () => {
    const { cloudflare } = await render('editor');
    expect(cloudflare).toEqual({
      projectId: PROJECT, state: 'attention', isReady: false, accountId: null, ...ADMIN_ONLY_NULLS,
    });
    const payload = JSON.stringify(cloudflare);
    for (const secret of [ACCOUNT_ID, 'wxyz', CLOUDFLARE.credentialId, 'cloudflare_authentication_failed']) {
      expect(payload).not.toContain(secret);
    }
  });

  it('hands Editors only the Gateway card’s generic readiness', async () => {
    const { gateway } = await render('editor');
    expect(gateway).toEqual({ projectId: PROJECT, state: 'ready', isReady: true, source: null, ...ADMIN_ONLY_NULLS });
  });

  it('hands Admins the full summaries', async () => {
    const { cloudflare, gateway } = await render('admin');
    expect(cloudflare).toEqual(CLOUDFLARE);
    expect(gateway).toEqual(GATEWAY);
  });
});
