/**
 * The Cloudflare Workers AI credential domain API (contract §2.14): the connect /
 * rotate / disconnect server actions, the readiness summary and the Editor
 * redaction. The DB is a recording fake; crypto is real, with stubbed keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  revalidatePath: vi.fn(),
  assertProjectAdmin: vi.fn(),
  requireIdentity: vi.fn(),
  requireProjectViewer: vi.fn(),
  validate: vi.fn(),
  validateGateway: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/auth/viewer', () => ({
  assertProjectAdmin: mocks.assertProjectAdmin,
  requireIdentity: mocks.requireIdentity,
  requireProjectViewer: mocks.requireProjectViewer,
}));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn(), escapeHtml: (s: string) => s }));
vi.mock('@/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('@/lib/gateway/cloudflare-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/cloudflare-provider')>()),
  validateCloudflareCredential: mocks.validate,
}));
vi.mock('@/lib/gateway/project-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gateway/project-provider')>()),
  validateGatewayCredential: mocks.validateGateway,
}));

import { DrizzleQueryError, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  auditLog,
  evalSamples,
  kbDocuments,
  projectCloudflareCredentials,
  projectGatewayCredentials,
  projects,
} from '@/db/schema';
import {
  connectProjectCloudflare,
  connectProjectGateway,
  disconnectProjectCloudflare,
} from '@/app/admin/project-actions';
import type { ProjectCloudflareSummary as ClientProjectCloudflareSummary } from '@/components/admin/project-types';
import { decryptCloudflareCredential } from '@/lib/gateway/credential-crypto';
import {
  getProjectCloudflareSummary,
  redactProjectCloudflareSummary,
  type ProjectCloudflareSummary,
} from '@/lib/projects/repository';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const ROW_A = '00000000-0000-4000-8000-000000000002';
const OTHER_PROJECT = '00000000-0000-4000-8000-000000000003';
const ADMIN = '00000000-0000-4000-8000-000000000005';
const ADMIN_EMAIL = 'admin@example.test';
const ACCT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf_tok_abcdefghijklmnop0123';
const KEY = Buffer.alloc(32, 7).toString('base64');
const FP = 'fingerprint-test-key-material-32-bytes-minimum';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const dialect = new PgDialect();

type Op = { op: 'lock' | 'select' | 'insert' | 'update'; table?: unknown; values?: unknown; where?: unknown };

/** A recording drizzle stand-in. `select…limit` resolves `rows`; every write is recorded in order. */
function recordingDb(rows: unknown[]) {
  const ops: Op[] = [];
  const projections: Record<string, unknown>[] = [];
  const select = vi.fn((projection: Record<string, unknown>) => {
    projections.push(projection);
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      limit: async () => {
        ops.push({ op: 'select' });
        return rows;
      },
    };
    return chain;
  });
  const tx = {
    execute: vi.fn(async () => {
      ops.push({ op: 'lock' });
      return { rows: [] };
    }),
    select,
    update: vi.fn((table: unknown) => ({
      set: (values: unknown) => ({
        where: async (where: unknown) => {
          ops.push({ op: 'update', table, values, where });
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: async (values: unknown) => {
        ops.push({ op: 'insert', table, values });
      },
    })),
  };
  const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  mocks.getDb.mockReturnValue({ transaction, select });
  return { ops, projections, transaction, select };
}

/** Writes only, without the lock and the pointer read. */
const writes = (ops: Op[]) => ops.filter((o) => o.op === 'insert' || o.op === 'update');

/** JSON of recorded values. drizzle SQL (circular column refs) is rendered, bound params included. */
const serialize = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (v instanceof SQL ? dialect.sqlToQuery(v) : v));

/** How drizzle 0.45 surfaces a pg unique violation: the driver error is the wrapper's `cause`. */
function wrapped23505(constraint: string): Error {
  return Object.assign(new Error('Failed query: insert into "project_cloudflare_credentials" … params: …'), {
    cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint,
    }),
  });
}

/** The same shape built by the real drizzle wrapper class. */
function drizzleWrapped23505(constraint: string): Error {
  return new DrizzleQueryError(
    'insert into "project_cloudflare_credentials" …',
    [],
    Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint }),
  );
}

function connect(overrides: Partial<{ accountId: string; apiToken: string }> = {}) {
  return connectProjectCloudflare({ projectId: PROJECT, accountId: ACCT, apiToken: TOKEN, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PROJECT_GATEWAY_ENCRYPTION_KEY', KEY);
  vi.stubEnv('PROJECT_GATEWAY_ENCRYPTION_KEY_VERSION', 'test-v1');
  vi.stubEnv('PROJECT_GATEWAY_FINGERPRINT_KEY', FP);
  vi.stubEnv('AI_GATEWAY_API_KEY', '');
  mocks.assertProjectAdmin.mockResolvedValue({
    userId: ADMIN,
    email: ADMIN_EMAIL,
    role: 'admin',
    projectId: PROJECT,
  });
  mocks.validate.mockResolvedValue('ok');
  mocks.validateGateway.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('connectProjectCloudflare', () => {
  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['31 hex', 'f'.repeat(31)],
    ['33 hex', 'f'.repeat(33)],
    ['non-hex', 'g'.repeat(32)],
    ['two halves', '0123456789abcdef-0123456789abcdef'],
    ['a number', 42],
    ['null', null],
  ])('rejects a malformed account id before any network or DB work: %s', async (_label, value) => {
    // A crafted Server Action payload arrives exactly like this cast.
    await expect(connect({ accountId: value as unknown as string })).resolves.toEqual({
      ok: false,
      code: 'cloudflare_invalid_account_id',
    });
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['inner space', 'a b'],
    ['header injection', 'tok\nX: y'],
    ['non-ASCII', 'tök'],
    ['513 characters', 'x'.repeat(513)],
    ['a number', 7],
    ['undefined', undefined],
  ])(
    'rejects a blank or unsafe token before any network or DB work: %s',
    async (_label, value) => {
      await expect(connect({ apiToken: value as unknown as string })).resolves.toEqual({
        ok: false,
        code: 'cloudflare_invalid',
      });
      expect(mocks.validate).not.toHaveBeenCalled();
      expect(mocks.getDb).not.toHaveBeenCalled();
    },
  );

  it('maps validation outcomes without opening a transaction', async () => {
    for (const [verdict, code] of [
      ['invalid', 'cloudflare_invalid'],
      ['unreachable', 'cloudflare_unreachable'],
    ] as const) {
      mocks.validate.mockResolvedValueOnce(verdict);
      await expect(connect()).resolves.toEqual({ ok: false, code });
    }
    expect(mocks.validate).toHaveBeenCalledTimes(2);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('validates before the transaction starts', async () => {
    const db = recordingDb([{ currentCredentialId: null }]);
    let settle: (verdict: 'ok') => void = () => {};
    mocks.validate.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));

    const result = connect();
    await vi.waitFor(() => expect(mocks.validate).toHaveBeenCalledOnce());
    // The network check is still pending: no transaction (and no row lock) yet.
    expect(db.transaction).not.toHaveBeenCalled();
    settle('ok');

    await expect(result).resolves.toEqual({ ok: true });
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(
      db.transaction.mock.invocationCallOrder[0],
    );
  });

  it('connects: inserts an available healthy row, moves the pointer, audits cloudflare.connect', async () => {
    const db = recordingDb([{ currentCredentialId: null }]);

    await expect(
      connect({ accountId: '  0123456789ABCDEF0123456789ABCDEF ', apiToken: `  ${TOKEN} ` }),
    ).resolves.toEqual({ ok: true });

    // Validation saw the normalised values only.
    expect(mocks.validate).toHaveBeenCalledWith(ACCT, TOKEN);
    expect(db.ops.map((o) => o.op)).toEqual(['lock', 'select', 'insert', 'update', 'insert']);
    const [credential, pointer, audit] = writes(db.ops);
    expect(credential.table).toBe(projectCloudflareCredentials);
    expect(pointer.table).toBe(projects);
    expect(audit.table).toBe(auditLog);

    const row = credential.values as Record<string, unknown> & {
      id: string;
      encryptedSecret: string;
      encryptionNonce: string;
      encryptionTag: string;
      encryptionKeyVersion: string;
      secretFingerprint: string;
      secretLastFour: string;
    };
    expect(row).toMatchObject({
      projectId: PROJECT,
      accountId: ACCT,
      lifecycle: 'available',
      health: 'healthy',
      createdByUserId: ADMIN,
      encryptionKeyVersion: 'test-v1',
      secretLastFour: '0123',
    });
    expect(row.id).toMatch(UUID_RE);
    expect(row.verifiedAt).toBeInstanceOf(Date);
    expect(row.lastCheckedAt).toBe(row.verifiedAt);
    expect(row.secretFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.encryptedSecret).not.toContain(TOKEN);
    // The envelope is bound to this project, row and account: it opens to the token.
    expect(
      decryptCloudflareCredential({ projectId: PROJECT, credentialId: row.id, accountId: ACCT, envelope: row }),
    ).toBe(TOKEN);

    const set = pointer.values as { currentCloudflareCredentialId: string; cloudflareCredentialRevision: SQL; updatedAt: Date };
    expect(set.currentCloudflareCredentialId).toBe(row.id);
    expect(set.updatedAt).toBeInstanceOf(Date);
    expect(dialect.sqlToQuery(set.cloudflareCredentialRevision)).toMatchObject({
      sql: '"projects"."cloudflare_credential_revision" + 1',
      params: [],
    });

    expect(audit.values).toEqual({
      projectId: PROJECT,
      actor: ADMIN_EMAIL,
      action: 'cloudflare.connect',
      target: row.id,
      after: { lastFour: '0123', fingerprint: row.secretFingerprint },
    });
    expect(serialize(db.ops.map(({ values, where }) => ({ values, where })))).not.toContain(TOKEN);
    expect(serialize(audit.values)).not.toContain(ACCT);

    expect(mocks.revalidatePath.mock.calls).toEqual([
      [`/admin/p/${PROJECT}`],
      [`/admin/p/${PROJECT}/settings`],
      [`/admin/p/${PROJECT}/members`],
      [`/admin/p/${PROJECT}/keys`],
    ]);
  });

  it('rotates: retires the current row first and audits cloudflare.rotate', async () => {
    const db = recordingDb([{ currentCredentialId: ROW_A }]);

    await expect(connect()).resolves.toEqual({ ok: true });

    expect(db.ops.map((o) => o.op)).toEqual(['lock', 'select', 'update', 'insert', 'update', 'insert']);
    const [retire, credential, , audit] = writes(db.ops);
    expect(retire.table).toBe(projectCloudflareCredentials);
    expect(retire.values).toEqual({
      lifecycle: 'replaced',
      encryptedSecret: null,
      encryptionNonce: null,
      encryptionTag: null,
      replacedAt: expect.any(Date),
    });
    // Only the project's current, still-available row.
    expect(dialect.sqlToQuery(retire.where as SQL)).toMatchObject({
      sql: '("project_cloudflare_credentials"."project_id" = $1 and "project_cloudflare_credentials"."id" = $2 and "project_cloudflare_credentials"."lifecycle" = $3)',
      params: [PROJECT, ROW_A, 'available'],
    });
    expect(credential.table).toBe(projectCloudflareCredentials);
    expect(credential.values).toMatchObject({ lifecycle: 'available', health: 'healthy' });
    expect(audit.values).toMatchObject({
      action: 'cloudflare.rotate',
      target: (credential.values as { id: string }).id,
    });
  });

  it('does not touch the Vercel credential or its background-work markers', async () => {
    for (const currentCredentialId of [null, ROW_A]) {
      const db = recordingDb([{ currentCredentialId }]);
      await expect(connect()).resolves.toEqual({ ok: true });
      for (const op of writes(db.ops)) {
        expect([projectGatewayCredentials, kbDocuments, evalSamples]).not.toContain(op.table);
      }
    }
  });

  it('maps a wrapped fingerprint unique violation to cloudflare_in_use', async () => {
    for (const error of [
      wrapped23505('project_cloudflare_credentials_fingerprint_idx'),
      drizzleWrapped23505('project_cloudflare_credentials_fingerprint_idx'),
    ]) {
      const db = recordingDb([{ currentCredentialId: null }]);
      db.transaction.mockRejectedValueOnce(error);
      await expect(connect()).resolves.toEqual({ ok: false, code: 'cloudflare_in_use' });
    }
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('rethrows other failures', async () => {
    const selfCaused = new Error('cause cycle');
    (selfCaused as { cause?: unknown }).cause = selfCaused;
    for (const error of [
      wrapped23505('project_cloudflare_credentials_one_available_idx'),
      drizzleWrapped23505('project_cloudflare_credentials_one_available_idx'),
      new Error('boom'),
      selfCaused, // the bounded cause walk terminates
    ]) {
      const db = recordingDb([{ currentCredentialId: null }]);
      db.transaction.mockRejectedValueOnce(error);
      await expect(connect()).rejects.toBe(error);
    }
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('returns not_found when the project row vanished', async () => {
    const db = recordingDb([]);

    await expect(connect()).resolves.toEqual({ ok: false, code: 'not_found' });
    expect(db.ops.map((o) => o.op)).toEqual(['lock', 'select']);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('still throws auth failures', async () => {
    mocks.assertProjectAdmin.mockRejectedValueOnce(new Error('forbidden'));

    await expect(connect()).rejects.toThrow('forbidden');
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});

describe('disconnectProjectCloudflare', () => {
  it('disconnects: retires the row, clears the pointer, audits lastFour and fingerprint', async () => {
    const db = recordingDb([{ currentCredentialId: ROW_A, rowId: ROW_A, lastFour: '0123', fingerprint: 'fp' }]);

    await expect(disconnectProjectCloudflare({ projectId: PROJECT })).resolves.toEqual({ ok: true });

    expect(db.ops.map((o) => o.op)).toEqual(['lock', 'select', 'update', 'update', 'insert']);
    const [retire, pointer, audit] = writes(db.ops);
    expect(retire.table).toBe(projectCloudflareCredentials);
    expect(retire.values).toEqual({
      lifecycle: 'disconnected',
      encryptedSecret: null,
      encryptionNonce: null,
      encryptionTag: null,
      disconnectedAt: expect.any(Date),
    });
    expect(dialect.sqlToQuery(retire.where as SQL)).toMatchObject({
      sql: '("project_cloudflare_credentials"."project_id" = $1 and "project_cloudflare_credentials"."id" = $2)',
      params: [PROJECT, ROW_A],
    });
    expect(pointer.table).toBe(projects);
    expect(pointer.values).toMatchObject({ currentCloudflareCredentialId: null, updatedAt: expect.any(Date) });
    expect(dialect.sqlToQuery((pointer.values as { cloudflareCredentialRevision: SQL }).cloudflareCredentialRevision))
      .toMatchObject({ sql: '"projects"."cloudflare_credential_revision" + 1', params: [] });
    expect(audit.table).toBe(auditLog);
    expect(audit.values).toEqual({
      projectId: PROJECT,
      actor: ADMIN_EMAIL,
      action: 'cloudflare.disconnect',
      target: ROW_A,
      after: { lastFour: '0123', fingerprint: 'fp' },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/admin/p/${PROJECT}/settings`);
  });

  it('disconnect is idempotent', async () => {
    const db = recordingDb([{ currentCredentialId: null, rowId: null, lastFour: null, fingerprint: null }]);

    await expect(disconnectProjectCloudflare({ projectId: PROJECT })).resolves.toEqual({ ok: true });

    expect(db.ops.map((o) => o.op)).toEqual(['lock', 'select', 'update', 'insert']);
    const [pointer, audit] = writes(db.ops);
    expect(pointer.table).toBe(projects);
    expect(writes(db.ops).some((o) => o.table === projectCloudflareCredentials)).toBe(false);
    expect(audit.values).toMatchObject({ action: 'cloudflare.disconnect', target: PROJECT, after: null });
  });

  it('disconnect keeps auth failures thrown and reports a vanished project', async () => {
    mocks.assertProjectAdmin.mockRejectedValueOnce(new Error('forbidden'));
    await expect(disconnectProjectCloudflare({ projectId: PROJECT })).rejects.toThrow('forbidden');
    expect(mocks.getDb).not.toHaveBeenCalled();

    const db = recordingDb([]);
    await expect(disconnectProjectCloudflare({ projectId: PROJECT })).resolves.toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(db.ops.map((o) => o.op)).toEqual(['lock', 'select']);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('connectProjectGateway (CCR-1)', () => {
  it('Vercel connect now maps a wrapped 23505 to gateway_in_use (CCR-1)', async () => {
    for (const error of [
      wrapped23505('project_gateway_credentials_fingerprint_idx'),
      drizzleWrapped23505('project_gateway_credentials_fingerprint_idx'),
    ]) {
      const db = recordingDb([{ currentCredentialId: null }]);
      db.transaction.mockRejectedValueOnce(error);
      await expect(connectProjectGateway({ projectId: PROJECT, apiKey: 'vck_x' })).rejects.toThrow(
        new Error('gateway_in_use'),
      );
    }
    // Anything else still propagates unchanged.
    const db = recordingDb([{ currentCredentialId: null }]);
    const boom = new Error('boom');
    db.transaction.mockRejectedValueOnce(boom);
    await expect(connectProjectGateway({ projectId: PROJECT, apiKey: 'vck_x' })).rejects.toBe(boom);
  });
});

describe('Cloudflare summary and Editor redaction', () => {
  const CONNECTED_AT = new Date('2026-10-20T08:00:00Z');
  const CHECKED_AT = new Date('2026-10-20T09:00:00Z');
  const LINKED = {
    projectStatus: 'active',
    currentCredentialId: ROW_A,
    credentialId: ROW_A,
    credentialProjectId: PROJECT,
    accountId: ACCT,
    lifecycle: 'available',
    health: 'healthy',
    lastFour: '0123',
    connectedAt: CONNECTED_AT,
    verifiedAt: CONNECTED_AT,
    lastCheckedAt: CHECKED_AT,
    lastFailureCode: null,
  };
  const EMPTY = {
    credentialId: null,
    accountId: null,
    lifecycle: null,
    health: null,
    lastFour: null,
    connectedAt: null,
    verifiedAt: null,
    lastCheckedAt: null,
    lastFailureCode: null,
  };

  it('reports not_connected without a linked row', async () => {
    const db = recordingDb([
      { projectStatus: 'active', currentCredentialId: null, credentialProjectId: null, ...EMPTY },
    ]);

    await expect(getProjectCloudflareSummary(PROJECT)).resolves.toEqual({
      projectId: PROJECT,
      state: 'not_connected',
      isReady: false,
      ...EMPTY,
    });
    const [projection] = db.projections;
    for (const secret of ['encryptedSecret', 'encryptionNonce', 'encryptionTag', 'secretFingerprint']) {
      expect(Object.keys(projection)).not.toContain(secret);
    }
    // Only the project row and the Cloudflare table: never the Vercel credential (D3).
    for (const column of Object.values(projection) as { table: unknown }[]) {
      expect([projects, projectCloudflareCredentials]).toContain(column.table);
    }
  });

  it('reports ready only for an active project with an available healthy row', async () => {
    recordingDb([LINKED]);

    await expect(getProjectCloudflareSummary(PROJECT)).resolves.toEqual({
      projectId: PROJECT,
      state: 'ready',
      isReady: true,
      credentialId: ROW_A,
      accountId: ACCT,
      lifecycle: 'available',
      health: 'healthy',
      lastFour: '0123',
      connectedAt: CONNECTED_AT,
      verifiedAt: CONNECTED_AT,
      lastCheckedAt: CHECKED_AT,
      lastFailureCode: null,
    });
  });

  it.each([
    ['health invalid', { health: 'invalid', lastFailureCode: 'cloudflare_authentication_failed' }],
    ['health unchecked', { health: 'unchecked' }],
    ['health billing_attention', { health: 'billing_attention' }],
    ['project suspended', { projectStatus: 'suspended' }],
    ['lifecycle replaced', { lifecycle: 'replaced' }],
    ['lifecycle disconnected', { lifecycle: 'disconnected' }],
  ])('reports attention for every other linked state: %s', async (_label, patch) => {
    recordingDb([{ ...LINKED, ...patch }]);

    const summary = await getProjectCloudflareSummary(PROJECT);
    expect(summary).toMatchObject({ state: 'attention', isReady: false });
    // Admins still see the metadata that explains why.
    expect(summary).toMatchObject({
      credentialId: ROW_A,
      accountId: ACCT,
      lastFour: '0123',
      lifecycle: { ...LINKED, ...patch }.lifecycle,
      health: { ...LINKED, ...patch }.health,
    });
  });

  it('treats a mismatched join as not connected', async () => {
    recordingDb([{ ...LINKED, credentialProjectId: OTHER_PROJECT }]);

    await expect(getProjectCloudflareSummary(PROJECT)).resolves.toEqual({
      projectId: PROJECT,
      state: 'not_connected',
      isReady: false,
      ...EMPTY,
    });
  });

  it('throws not_found for a missing project', async () => {
    recordingDb([]);

    await expect(getProjectCloudflareSummary(PROJECT)).rejects.toThrow('not_found');
  });

  it('redacts everything but readiness for Editors', async () => {
    recordingDb([LINKED]);
    const ready: ProjectCloudflareSummary = await getProjectCloudflareSummary(PROJECT);

    // The server summary is what Client Components receive (Date is assignable to Date | string).
    const forClient: ClientProjectCloudflareSummary = redactProjectCloudflareSummary(ready, 'editor');
    expect(forClient).toEqual({
      projectId: PROJECT,
      state: 'ready',
      isReady: true,
      ...EMPTY,
    });
    expect(redactProjectCloudflareSummary(ready, 'admin')).toBe(ready);
  });
});
