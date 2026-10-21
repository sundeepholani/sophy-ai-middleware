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
    connectProjectCloudflare: vi.fn(), disconnectProjectCloudflare: vi.fn(),
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
  repository: {
    listProjectsForUser: vi.fn(), getProjectGatewaySummary: vi.fn(), getProjectCloudflareSummary: vi.fn(),
    listProjectMembers: vi.fn(), listProjectInvitations: vi.fn(),
  },
  settings: vi.fn(), models: vi.fn(),
}));

vi.mock('@/app/admin/actions', () => mocks.keys);
vi.mock('@/app/admin/project-actions', () => mocks.projects);
vi.mock('@/app/admin/kb-actions', () => mocks.kb);
vi.mock('@/lib/admin/queries', () => mocks.queries);
// The real, pure redaction proves the CLI's Editor boundary without a database;
// every DB-backed repository function stays mocked. (The real module's imports —
// db/client (lazy), schema, env (lazy), project-provider — are all import-safe;
// none of them imports '@/lib/gateway/models', which this file mocks partially.)
vi.mock('@/lib/projects/repository', async (importOriginal) => ({
  ...mocks.repository,
  redactProjectCloudflareSummary:
    (await importOriginal<typeof import('@/lib/projects/repository')>()).redactProjectCloudflareSummary,
}));
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
const ACCOUNT = '0123456789abcdef0123456789abcdef';
// The last four characters must not occur in the PROJECT or OTHER ids (…0001, …0003).
const CF_TOKEN = 'synthetic-cloudflare-token-wxyz';
const AT = new Date('2026-10-20T00:00:00.000Z');
const CF_SUMMARY = {
  projectId: PROJECT, state: 'ready', isReady: true, credentialId: OTHER, accountId: ACCOUNT,
  lifecycle: 'available', health: 'healthy', lastFour: 'wxyz',
  connectedAt: AT, verifiedAt: AT, lastCheckedAt: AT, lastFailureCode: null,
};
const REDACTED = {
  projectId: PROJECT, state: 'ready', isReady: true, credentialId: null, accountId: null,
  lifecycle: null, health: null, lastFour: null, connectedAt: null, verifiedAt: null,
  lastCheckedAt: null, lastFailureCode: null,
};
const post = (body: unknown) => POST(new Request('https://sophy.test/api/admin/cli', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sophy_cli_test' },
  body: JSON.stringify(body),
}));

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
    ['cloudflare.connect', { accountId: ACCOUNT, apiToken: CF_TOKEN }], ['cloudflare.disconnect', {}],
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
    ['logs.list', { limit: 100_000 }], ['logs.list', { keyId: 'key-1' }], ['usage.get', { sinceDays: -1 }],
    ['evals.start', { apiKeyId: KEY, challengerModel: 'model', targetN: 10_000 }],
    ['cloudflare.connect', { accountId: ACCOUNT }],
    ['cloudflare.connect', { accountId: ACCOUNT, apiToken: '   ' }],
    ['cloudflare.connect', { accountId: ACCOUNT, apiToken: 'x'.repeat(513) }],
    ['cloudflare.connect', { accountId: ACCOUNT, apiToken: 12345 }],
    ['cloudflare.connect', { accountId: 'a'.repeat(65), apiToken: CF_TOKEN }],
    ['cloudflare.connect', { accountId: ACCOUNT, apiToken: CF_TOKEN, projectId: OTHER }],
    ['cloudflare.status', { projectId: OTHER }],
    ['cloudflare.disconnect', { projectId: OTHER }],
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

  it('reads one key’s 100 most recent logs only when that key is in the viewer’s scope', async () => {
    await call('logs.list', { keyId: KEY });
    expect(mocks.queries.getRecentLogs).toHaveBeenCalledWith(VIEWER, 100, undefined, KEY);
    await call('logs.list');
    expect(mocks.queries.getRecentLogs).toHaveBeenLastCalledWith(VIEWER, 100, undefined, undefined);
    // listKeys is owner-scoped, so another editor's key is indistinguishable
    // from a missing one and never reaches the log query.
    await expect(call('logs.list', { keyId: OTHER })).rejects.toThrow('not_found');
    expect(mocks.queries.getRecentLogs).toHaveBeenCalledTimes(2);
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

describe('Cloudflare credential CLI operations', () => {
  const connect = { operation: 'cloudflare.connect', projectId: PROJECT, input: { accountId: ACCOUNT, apiToken: CF_TOKEN } };

  it('returns the full Cloudflare summary to an Admin', async () => {
    mocks.repository.getProjectCloudflareSummary.mockResolvedValue(CF_SUMMARY);
    expect(await call('cloudflare.status')).toEqual(CF_SUMMARY);
    expect(mocks.repository.getProjectCloudflareSummary).toHaveBeenCalledWith(PROJECT);
  });

  it('returns only state and readiness to an Editor', async () => {
    mocks.viewer.mockResolvedValue({ ...VIEWER, role: 'editor' });
    mocks.repository.getProjectCloudflareSummary.mockResolvedValue(CF_SUMMARY);
    const result = await call('cloudflare.status');
    expect(result).toEqual(REDACTED);
    expect(JSON.stringify(result)).not.toContain(ACCOUNT);
  });

  it('serves Editors no Admin-only metadata over HTTP and Admins ISO timestamps', async () => {
    mocks.viewer.mockResolvedValue({ ...VIEWER, role: 'editor' });
    mocks.repository.getProjectCloudflareSummary.mockResolvedValue({
      ...CF_SUMMARY, state: 'attention', isReady: false, health: 'invalid', lastFailureCode: 'cloudflare_authentication_failed',
    });
    const response = await post({ operation: 'cloudflare.status', projectId: PROJECT });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true, data: { ...REDACTED, state: 'attention', isReady: false } });
    for (const hidden of [ACCOUNT, OTHER, 'wxyz', 'invalid', 'cloudflare_authentication_failed']) expect(text).not.toContain(hidden);
    mocks.viewer.mockResolvedValue(VIEWER);
    const admin = await (await post({ operation: 'cloudflare.status', projectId: PROJECT })).json();
    expect(admin.data).toMatchObject({ accountId: ACCOUNT, lastFour: 'wxyz', health: 'invalid', verifiedAt: AT.toISOString() });
  });

  it('delegates connect and disconnect to the console actions for the selected project', async () => {
    mocks.projects.connectProjectCloudflare.mockResolvedValue({ ok: true });
    mocks.projects.disconnectProjectCloudflare.mockResolvedValue({ ok: true });
    expect(await call('cloudflare.connect', { accountId: `  ${ACCOUNT.toUpperCase()} `, apiToken: `\t${CF_TOKEN}\n` })).toEqual({ ok: true });
    // Trimmed at the JSON boundary; case and format normalisation belong to the action.
    expect(mocks.projects.connectProjectCloudflare).toHaveBeenCalledWith({ projectId: PROJECT, accountId: ACCOUNT.toUpperCase(), apiToken: CF_TOKEN });
    expect(await call('cloudflare.disconnect')).toEqual({ ok: true });
    expect(mocks.projects.disconnectProjectCloudflare).toHaveBeenCalledWith({ projectId: PROJECT });
  });

  it.each([
    ['cloudflare_invalid_account_id', 400, 'Enter the 32-character Cloudflare account ID.'],
    ['cloudflare_invalid', 400, 'The Cloudflare account ID or API token was rejected. Create the token from Cloudflare\'s "Workers AI" template.'],
    ['cloudflare_unreachable', 503, 'Cloudflare could not be reached to validate the credential. Try again.'],
    ['cloudflare_in_use', 409, 'This Cloudflare API token is already in use by another project.'],
    ['not_found', 404, 'The resource is unavailable in your project or access scope.'],
  ] as const)('maps a connect result of %s to HTTP %i without echoing the token', async (code, status, message) => {
    mocks.projects.connectProjectCloudflare.mockResolvedValue({ ok: false, code });
    const response = await post(connect);
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code, message } });
    expect(text).not.toContain(CF_TOKEN);
  });

  it('keeps disconnect results and action auth failures on the existing codes', async () => {
    mocks.projects.disconnectProjectCloudflare.mockResolvedValue({ ok: false, code: 'not_found' });
    expect((await post({ operation: 'cloudflare.disconnect', projectId: PROJECT })).status).toBe(404);
    mocks.projects.connectProjectCloudflare.mockRejectedValue(new Error('forbidden'));
    const response = await post(connect);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden');
  });

  it('fails closed on an unknown result code and masks thrown details', async () => {
    mocks.projects.connectProjectCloudflare.mockResolvedValue({ ok: false, code: 'cloudflare_surprise' });
    let response = await post(connect);
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe('internal_error');
    mocks.projects.connectProjectCloudflare.mockRejectedValue(new Error(`decrypt failed for ${CF_TOKEN} on ${ACCOUNT}`));
    response = await post(connect);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(CF_TOKEN);
    expect(text).not.toContain(ACCOUNT);
  });

  it('rejects an oversized token with field paths only, before auth or the action', async () => {
    const response = await post({ ...connect, input: { accountId: ACCOUNT, apiToken: CF_TOKEN.repeat(20) } });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'invalid_request', message: 'Invalid fields: apiToken.' } });
    expect(text).not.toContain(CF_TOKEN);
    expect(mocks.viewer).not.toHaveBeenCalled();
    expect(mocks.projects.connectProjectCloudflare).not.toHaveBeenCalled();
  });

  it('maps the Cloudflare key-binding errors thrown by the console key actions', async () => {
    mocks.keys.createKey.mockRejectedValue(new Error('cloudflare_not_ready'));
    let response = await post({ operation: 'keys.create', projectId: PROJECT, input: { name: 'Clef', model: '@cf/cloudflare/clef' } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: 'cloudflare_not_ready', message: 'Connect a healthy project Cloudflare credential first.' } });
    expect(mocks.keys.createKey).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT, model: '@cf/cloudflare/clef' }));
    mocks.keys.bulkUpdateKeyModel.mockRejectedValue(new Error('cloudflare_not_ready'));
    response = await post({ operation: 'keys.bulk-model', projectId: PROJECT, input: { ids: [KEY], model: '@cf/cloudflare/clef-flash' } });
    expect(response.status).toBe(409);
    mocks.keys.updateKey.mockRejectedValue(new Error('Unsupported Cloudflare Workers AI model'));
    response = await post({ operation: 'keys.update', projectId: PROJECT, input: { id: KEY, model: '@cf/cloudflare/not-registered' } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'invalid_request', message: 'Unsupported Cloudflare Workers AI model' } });
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
