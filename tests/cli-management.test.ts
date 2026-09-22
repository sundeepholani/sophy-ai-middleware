import { beforeEach, describe, expect, it, vi } from 'vitest';
import manifest from '../cli/operations.json';

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(), identity: vi.fn(), session: vi.fn(), rate: vi.fn(),
  keys: {
    createKey: vi.fn(), updateKey: vi.fn(), rotateKey: vi.fn(), revokeKey: vi.fn(),
    bulkUpdateKeyModel: vi.fn(), startEvalRun: vi.fn(), bulkStartEvalRuns: vi.fn(),
    cancelEvalRun: vi.fn(), refreshKeyEval: vi.fn(), updateSettings: vi.fn(),
  },
  projects: {
    createProject: vi.fn(), ensureRecoveryProject: vi.fn(), setDefaultProject: vi.fn(),
    renameProject: vi.fn(), connectProjectGateway: vi.fn(), disconnectProjectGateway: vi.fn(),
    inviteProjectMember: vi.fn(), changeProjectMemberRole: vi.fn(), changeProjectMemberStatus: vi.fn(),
    removeProjectMember: vi.fn(), changeProjectInvitationRole: vi.fn(), resendProjectInvitation: vi.fn(), revokeProjectInvitation: vi.fn(),
  },
  kb: {
    createKnowledgebase: vi.fn(), deleteKnowledgebase: vi.fn(), listKbDocumentsAction: vi.fn(),
    uploadKbDocumentAction: vi.fn(), deleteKbDocument: vi.fn(), retryKbDocument: vi.fn(),
  },
  queries: {
    listKeys: vi.fn(), listEvalRuns: vi.fn(), getEvalRunDetail: vi.fn(), getOverview: vi.fn(),
    getUsageTotals: vi.fn(), getUsageByKey: vi.fn(), getUsageByModel: vi.fn(), getUsageBySource: vi.fn(),
    getUsageSeries: vi.fn(), getUsageStacked: vi.fn(), getRecentLogs: vi.fn(), getLogDetail: vi.fn(),
    listKnowledgebases: vi.fn(), listKnowledgebaseOptions: vi.fn(),
  },
  repository: { listProjectsForUser: vi.fn(), getProjectGatewaySummary: vi.fn(), listProjectMembers: vi.fn(), listProjectInvitations: vi.fn() },
  settings: vi.fn(), models: vi.fn(),
}));

vi.mock('@/app/admin/actions', () => mocks.keys);
vi.mock('@/app/admin/project-actions', () => mocks.projects);
vi.mock('@/app/admin/kb-actions', () => mocks.kb);
vi.mock('@/lib/admin/queries', () => mocks.queries);
vi.mock('@/lib/projects/repository', () => mocks.repository);
vi.mock('@/lib/admin/settings', () => ({ getSettings: mocks.settings }));
vi.mock('@/lib/gateway/models', () => ({ listAllModels: mocks.models }));
vi.mock('@/lib/auth/viewer', () => ({ requireProjectViewer: mocks.viewer, requireIdentity: mocks.identity }));
vi.mock('@/lib/auth/cli-session', () => ({
  resolveCliSession: mocks.session,
  withCliIdentity: (_identity: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock('@/lib/counters', () => ({ checkRateLimit: mocks.rate }));

import { dispatchCliOperation, dispatchCliUpload, cliOperationNames } from '@/lib/admin/cli-operations';
import { cliErrorResponse } from '@/lib/admin/cli-http';
import { POST } from '@/app/api/admin/cli/route';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const KEY = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const VIEWER = { userId: OTHER, projectId: PROJECT, role: 'admin', email: 'owner@example.com' };
const CURRENT_KEY = {
  id: KEY, name: 'Existing', model: 'vendor/model', systemPrompt: 'Keep this prompt',
  params: { allowClientPrompt: true, temperature: 0.5 }, outputSchema: null, monthlyCostCapUsd: 35,
  rpmLimit: 12, logContent: false, ownerUserId: OTHER, knowledgebaseId: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.viewer.mockResolvedValue(VIEWER);
  mocks.identity.mockResolvedValue(VIEWER);
  mocks.session.mockResolvedValue({ ...VIEWER, sessionId: KEY, expiresAt: new Date(Date.now() + 1000) });
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.queries.listKeys.mockResolvedValue([CURRENT_KEY]);
});

const call = (operation: string, input: unknown = {}, projectId: string | undefined = PROJECT) => dispatchCliOperation({ operation, input, projectId });

describe('CLI management permission and input boundary', () => {
  it('covers every published CLI command with a server operation', () => {
    expect([...cliOperationNames].sort()).toEqual(manifest.map((item) => item.operation).sort());
  });

  it('requires active project membership before any project read or write', async () => {
    mocks.viewer.mockRejectedValue(new Error('forbidden'));
    await expect(call('keys.list')).rejects.toThrow('forbidden');
    await expect(call('keys.rotate', { id: KEY })).rejects.toThrow('forbidden');
    expect(mocks.queries.listKeys).not.toHaveBeenCalled();
    expect(mocks.keys.rotateKey).not.toHaveBeenCalled();
  });

  it.each([
    ['projects.rename', { name: 'New name' }], ['gateway.connect', { apiKey: 'secret' }],
    ['gateway.disconnect', {}], ['members.list', {}], ['members.invite', { email: 'new@example.com', role: 'admin' }],
    ['members.role', { userId: OTHER, role: 'admin' }], ['members.status', { userId: OTHER, active: true }],
    ['members.remove', { userId: OTHER }], ['invitations.list', {}],
    ['invitations.role', { invitationId: OTHER, role: 'admin' }], ['invitations.resend', { invitationId: OTHER }],
    ['invitations.revoke', { invitationId: OTHER }], ['settings.get', {}],
    ['settings.update', { judgeModel: 'vendor/model', notifyEmail: null }],
  ])('does not give an Editor admin powers via %s', async (operation, input) => {
    mocks.viewer.mockResolvedValue({ ...VIEWER, role: 'editor' });
    await expect(call(operation, input)).rejects.toThrow('forbidden');
    for (const fn of [...Object.values(mocks.projects), mocks.settings, mocks.keys.updateSettings]) expect(fn).not.toHaveBeenCalled();
  });

  it('uses the fresh role rather than retaining a previous admin result', async () => {
    await call('members.list');
    mocks.viewer.mockResolvedValue({ ...VIEWER, role: 'editor' });
    await expect(call('members.list')).rejects.toThrow('forbidden');
    expect(mocks.repository.listProjectMembers).toHaveBeenCalledTimes(1);
  });

  it('uses owner-scoped key reads and preserves omitted settings on edits', async () => {
    mocks.viewer.mockResolvedValue({ ...VIEWER, role: 'editor' });
    await call('keys.update', { id: KEY, name: 'Renamed' });
    expect(mocks.keys.updateKey).toHaveBeenCalledWith({ ...CURRENT_KEY, name: 'Renamed', projectId: PROJECT });
    await expect(call('keys.update', { id: OTHER, name: 'Forbidden' })).rejects.toThrow('not_found');
    expect(mocks.keys.updateKey).toHaveBeenCalledTimes(1);
  });

  it('delegates secret rotation and creation to the console actions', async () => {
    mocks.keys.rotateKey.mockResolvedValue({ fullKey: 'mw_live_new' });
    expect(await call('keys.rotate', { id: KEY })).toEqual({ fullKey: 'mw_live_new' });
    expect(mocks.keys.rotateKey).toHaveBeenCalledWith({ id: KEY, projectId: PROJECT });
    await call('keys.create', { name: 'API', model: 'vendor/model' });
    expect(mocks.keys.createKey).toHaveBeenCalledWith({ projectId: PROJECT, name: 'API', model: 'vendor/model', systemPrompt: null, params: {}, outputSchema: null, rpmLimit: null, logContent: false });
  });

  it.each([
    ['keys.update', { id: KEY, stopRunningEval: 'true' }],
    ['keys.create', { name: 'Key', model: 'vendor/model', logContent: 'false' }],
    ['keys.create', { name: 'Key', model: 'vendor/model', params: { allowClientPrompt: 'false' } }],
    ['members.status', { userId: OTHER, active: 'false' }],
    ['members.role', { userId: OTHER, role: 'superadmin' }],
    ['keys.rotate', { id: KEY, projectId: OTHER }],
    ['logs.list', { limit: 100_000 }], ['usage.get', { sinceDays: -1 }],
    ['evals.start', { apiKeyId: KEY, challengerModel: 'model', targetN: 10_000 }],
  ])('rejects malformed or excessive input to %s', async (operation, input) => {
    await expect(call(operation, input)).rejects.toThrow();
    expect(mocks.viewer).not.toHaveBeenCalled();
  });

  it('does not allow prototype property operation names or missing projects', async () => {
    await expect(call('__proto__')).rejects.toThrow('Unknown CLI operation');
    await expect(dispatchCliOperation({ operation: 'keys.list' })).rejects.toThrow('Select a project');
  });

  it('passes all reporting reads the authorized project viewer', async () => {
    await call('usage.get', { keyId: OTHER });
    for (const fn of [mocks.queries.getUsageTotals, mocks.queries.getUsageByKey, mocks.queries.getUsageByModel, mocks.queries.getUsageBySource]) {
      expect(fn).toHaveBeenCalledWith(VIEWER, { keyId: OTHER, sinceDays: 30 });
    }
    await call('logs.get', { id: KEY }).catch(() => undefined);
    expect(mocks.queries.getLogDetail).toHaveBeenCalledWith(VIEWER, KEY);
  });

  it('uses the console document access guard and rejects duplicate multipart fields', async () => {
    await call('knowledgebases.documents', { kbId: KEY });
    expect(mocks.kb.listKbDocumentsAction).toHaveBeenCalledWith({ projectId: PROJECT, kbId: KEY });
    const form = new FormData();
    form.set('operation', 'knowledgebases.upload'); form.set('projectId', PROJECT); form.set('kbId', KEY);
    form.set('file', new File(['hello'], 'doc.txt', { type: 'text/plain' }));
    await dispatchCliUpload(form);
    expect(mocks.kb.uploadKbDocumentAction).toHaveBeenCalledWith(form);
    form.append('projectId', OTHER);
    await expect(dispatchCliUpload(form)).rejects.toThrow('duplicate');
    expect(mocks.kb.uploadKbDocumentAction).toHaveBeenCalledTimes(1);
  });
});

describe('management HTTP contract', () => {
  const request = (body: string, headers: Record<string, string> = {}) => new Request('https://sophy.test/api/admin/cli', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sophy_cli_test', ...headers }, body,
  });

  it('rejects an invalid session before reading an operation', async () => {
    mocks.session.mockResolvedValue(null);
    const response = await POST(request('{not even JSON}', { cookie: 'aimw_admin=browser-cookie' }));
    expect(response.status).toBe(401);
    expect(mocks.viewer).not.toHaveBeenCalled();
  });

  it('returns no-store JSON without issuing browser cookies', async () => {
    const response = await POST(request(JSON.stringify({ operation: 'keys.list', projectId: PROJECT })));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(await response.json()).toEqual({ ok: true, data: [CURRENT_KEY] });
  });

  it('rejects oversized bodies without relying on Content-Length', async () => {
    const response = await POST(request('x'.repeat(1024 * 1024 + 1)));
    expect(response.status).toBe(413);
    expect(mocks.viewer).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and non-JSON media types', async () => {
    expect((await POST(request('null'))).status).toBe(400);
    expect((await POST(request('{oops'))).status).toBe(400);
    expect((await POST(request('{}', { 'content-type': 'text/plain' }))).status).toBe(415);
  });

  it('bounds management request frequency', async () => {
    mocks.rate.mockResolvedValue({ ok: false });
    const response = await POST(request('{}'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('masks SQL, credential, and schema compilation details', async () => {
    const sensitive = 'insert into secrets values (top-secret-token)';
    const response = cliErrorResponse(new Error(sensitive));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(sensitive);
    expect(await cliErrorResponse(new Error(`Output schema is not a valid JSON Schema: ${sensitive}`)).text()).not.toContain(sensitive);
  });
});
