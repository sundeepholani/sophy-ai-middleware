/**
 * Real management SQL and permission checks. Opt in only with
 * SOPHY_TEST_DATABASE_URL pointing to a local database named sophy_test.
 * Each run creates and drops its own schema. No provider requests are made.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import previousSnapshot from '../drizzle/meta/0013_snapshot.json';

const fixture = vi.hoisted(() => ({ db: undefined as unknown }));
// The client facade points to a real, isolated PostgreSQL connection. Queries,
// authorization, transaction boundaries and mutations are not mocked.
vi.mock('@/db/client', () => ({ getDb: () => fixture.db }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: () => { throw new Error('CLI management must not read browser cookies'); },
  headers: () => { throw new Error('This test must not read a browser request'); },
}));
vi.mock('@/lib/gateway/models', async (original) => ({
  ...await original<typeof import('@/lib/gateway/models')>(),
  listAllModels: async () => [],
}));
import { APICallError } from 'ai';
import { dispatchCliOperation } from '@/lib/admin/cli-operations';
import { cliErrorResponse } from '@/lib/admin/cli-http';
import { withCliIdentity } from '@/lib/auth/cli-session';
import { issueKey, verifyKey } from '@/lib/auth/api-key';
import { connectProjectCloudflare, disconnectProjectCloudflare } from '@/app/admin/project-actions';
import {
  getProjectCloudflareSummary,
  getProjectGatewaySummary,
  redactProjectCloudflareSummary,
} from '@/lib/projects/repository';
import { normalizeProjectCloudflareError, resolveProjectCloudflare } from '@/lib/gateway/cloudflare-provider';
import { cloudflareRunUrlForLogs, type CloudflareErrorInfo } from '@/lib/gateway/cloudflare-call';
import { ProjectCloudflareUnavailableError } from '@/lib/gateway/project-provider';

const url = process.env.SOPHY_TEST_DATABASE_URL;
const schemaName = `cli_management_${randomUUID().replaceAll('-', '')}`;
const tableNames = [
  'users', 'projects', 'project_memberships', 'project_invitations',
  'project_gateway_credentials', 'project_settings', 'knowledgebases',
  'kb_documents', 'api_keys', 'eval_runs', 'audit_log', 'usage_events', 'eval_samples',
  'login_challenges', 'cli_sessions',
];
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
type User = typeof schema.users.$inferSelect;
type Issued = Awaited<ReturnType<typeof issueKey>>;
let admin: User, editor: User, peer: User, outsider: User;
let projectA: string, projectB: string;
let owned: Issued, unowned: Issued, foreign: Issued, ownedElsewhere: Issued;
let ownedKb: string, sharedKb: string, foreignKb: string;

type SnapshotTable = {
  name: string;
  columns: Record<string, { name: string; type: string; primaryKey: boolean; notNull: boolean; default?: string }>;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  uniqueConstraints: Record<string, { name: string; columns: string[] }>;
  indexes: Record<string, { name: string; isUnique: boolean; columns: Array<{ expression: string }>; where?: string }>;
  foreignKeys: Record<string, { name: string; tableFrom: string; tableTo: string; columnsFrom: string[]; columnsTo: string[]; onDelete: string }>;
  checkConstraints: Record<string, { name: string; value: string }>;
};
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

function call(user: User, operation: string, input: unknown = {}, projectId = projectA) {
  return withCliIdentity({
    userId: user.id, email: user.email, sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  }, () => dispatchCliOperation({ operation, projectId, input }));
}

async function keyRecord(id: string) {
  const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
  return key;
}

/** drizzle-orm 0.45 wraps driver errors in DrizzleQueryError; the pg error is `.cause`. */
async function dbError(run: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try { await run; } catch (error) {
    return ((error as { cause?: unknown }).cause ?? error) as { code?: string; constraint?: string };
  }
  throw new Error('expected the database to reject the statement');
}

const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';
async function cloudflareRow(projectId: string, creator: string,
  overrides: Partial<typeof schema.projectCloudflareCredentials.$inferInsert> = {}) {
  const [row] = await db.insert(schema.projectCloudflareCredentials).values({
    projectId, accountId: CF_ACCOUNT, lifecycle: 'available', health: 'healthy',
    encryptedSecret: 'synthetic-ciphertext', encryptionNonce: 'synthetic-nonce', encryptionTag: 'synthetic-tag',
    encryptionKeyVersion: 'test', secretFingerprint: randomUUID(), secretLastFour: 'abcd', createdByUserId: creator,
    ...overrides,
  }).returning();
  return row;
}
const RETIRED_ENVELOPE = {
  lifecycle: 'replaced', encryptedSecret: null, encryptionNonce: null, encryptionTag: null,
} as const;

const CF_TOKEN_ONE = 'cf_integration_token_one_0001';
const CF_TOKEN_TWO = 'cf_integration_token_two_0002';

/** Run a server action as `user`, exactly as the CLI scopes its identity. */
function asUser<T>(user: User, fn: () => Promise<T>): Promise<T> {
  return withCliIdentity({
    userId: user.id, email: user.email, sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  }, fn);
}

/** Cloudflare's free validation call answers ok; the SAME forbidden fetch mock is restored after. */
async function withValidCloudflare<T>(fn: () => Promise<T>): Promise<T> {
  const forbidden = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result: [] })));
  try { return await fn(); } finally { vi.stubGlobal('fetch', forbidden); }
}

function connectCloudflare(user: User, projectId: string, apiToken: string, accountId = CF_ACCOUNT) {
  return withValidCloudflare(() => asUser(user, () => connectProjectCloudflare({ projectId, accountId, apiToken })));
}

async function projectRecord(id: string) {
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  return project;
}

async function credentialRecord(id: string) {
  const [row] = await db.select().from(schema.projectCloudflareCredentials).where(eq(schema.projectCloudflareCredentials.id, id));
  return row;
}

/** A Cloudflare 401 exactly as postCloudflareOnce lifts it. */
function cloudflare401() {
  return new APICallError({
    message: 'Authentication error', url: cloudflareRunUrlForLogs('@cf/cloudflare/clef'), requestBodyValues: {},
    statusCode: 401, isRetryable: false,
    data: { provider: 'cloudflare', code: 10000, message: 'Authentication error', requestId: null, neurons: null } satisfies CloudflareErrorInfo,
  });
}

// CLI-layer Cloudflare cases. The file's fetch stub forbids every request; a test
// that lets connect reach it queues a synthetic answer and resets it in a finally.
const CF_SEARCH_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/models/search?search=clef&per_page=1`;
const cfOk = () => Promise.resolve(Response.json({ success: true, result: [], errors: [], messages: [] }));
/** Every Admin-only summary field, as an Editor (or a project with no credential) sees it. */
const CF_NULLS = {
  credentialId: null, accountId: null, lifecycle: null, health: null, lastFour: null,
  connectedAt: null, verifiedAt: null, lastCheckedAt: null, lastFailureCode: null,
};

/** A directly seeded current Cloudflare credential: the row plus the project's pointer to it. */
async function seedCloudflare(projectId: string, creator: string) {
  const row = await cloudflareRow(projectId, creator, { verifiedAt: new Date(), lastCheckedAt: new Date() });
  await db.update(schema.projects).set({ currentCloudflareCredentialId: row.id }).where(eq(schema.projects.id, projectId));
  return row;
}

describe.skipIf(!url)('CLI management on real PostgreSQL', () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/sophy_test') {
      throw new Error('Management integration tests require a local synthetic sophy_test database');
    }
    vi.stubEnv('KEY_HASH_PEPPER', 'synthetic-management-test-pepper');
    // Project credential crypto (golden values). Stubbed here, never per test: an
    // afterEach unstub would also drop the pepper that beforeEach's issueKey needs.
    vi.stubEnv('PROJECT_GATEWAY_ENCRYPTION_KEY', 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=');
    vi.stubEnv('PROJECT_GATEWAY_ENCRYPTION_KEY_VERSION', 'test-v1');
    vi.stubEnv('PROJECT_GATEWAY_FINGERPRINT_KEY', 'fingerprint-test-key-material-32-bytes-minimum');
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests are forbidden in this test'); }));
    const bootstrap = new Pool({ connectionString: url });
    try { await bootstrap.query(`create schema ${q(schemaName)}`); }
    finally { await bootstrap.end(); }
    pool = new Pool({ connectionString: url, max: 8, options: `-c search_path=${schemaName}` });
    db = drizzle(pool, { schema });
    fixture.db = db;
    const tables = tableNames.map((name) => (previousSnapshot.tables as unknown as Record<string, SnapshotTable>)[`public.${name}`]);
    // Build the relevant previous-schema tables from the checked-in snapshot,
    // including actual uniqueness, checks and foreign keys. Vector storage is
    // not used by these key/KB access tests and requires no pgvector extension.
    for (const table of tables) {
      const columns = Object.values(table.columns).map((c) => `${q(c.name)} ${c.type}${c.default === undefined ? '' : ` default ${c.default}`}${c.notNull ? ' not null' : ''}${c.primaryKey ? ' primary key' : ''}`);
      for (const pk of Object.values(table.compositePrimaryKeys)) columns.push(`primary key (${pk.columns.map(q).join(',')})`);
      for (const unique of Object.values(table.uniqueConstraints)) columns.push(`constraint ${q(unique.name)} unique (${unique.columns.map(q).join(',')})`);
      for (const check of Object.values(table.checkConstraints)) columns.push(`constraint ${q(check.name)} check (${check.value})`);
      await pool.query(`create table ${q(table.name)} (${columns.join(',')})`);
      for (const index of Object.values(table.indexes)) {
        await pool.query(`create ${index.isUnique ? 'unique ' : ''}index ${q(index.name)} on ${q(table.name)} (${index.columns.map((c) => q(c.expression)).join(',')})${index.where ? ` where ${index.where}` : ''}`);
      }
    }
    for (const table of tables) for (const fk of Object.values(table.foreignKeys)) {
      if (!tableNames.includes(fk.tableTo)) throw new Error(`Missing fixture table for ${fk.name}`);
      await pool.query(`alter table ${q(fk.tableFrom)} add constraint ${q(fk.name)} foreign key (${fk.columnsFrom.map(q).join(',')}) references ${q(fk.tableTo)} (${fk.columnsTo.map(q).join(',')}) on delete ${fk.onDelete}`);
    }
    const migration = readFileSync(new URL('../drizzle/0014_project_cloudflare_credentials.sql', import.meta.url), 'utf8');
    await pool.query(migration.replaceAll('"public".', `${q(schemaName)}.`));
  });

  beforeEach(async () => {
    await pool.query(`truncate ${[...tableNames, 'project_cloudflare_credentials'].map(q).join(',')} cascade`);
    [admin, editor, peer, outsider] = await db.insert(schema.users).values(
      ['admin', 'editor', 'peer', 'outsider'].map((name) => ({ email: `${name}@example.test` })),
    ).returning();
    const projects = await db.insert(schema.projects).values([
      { name: 'Project A', slug: 'a', createdByUserId: admin.id },
      { name: 'Project B', slug: 'b', createdByUserId: outsider.id },
    ]).returning();
    [projectA, projectB] = projects.map((project) => project.id);
    await db.insert(schema.projectMemberships).values([
      { projectId: projectA, userId: admin.id, role: 'admin' },
      { projectId: projectA, userId: editor.id, role: 'editor' },
      { projectId: projectA, userId: peer.id, role: 'editor' },
      { projectId: projectB, userId: admin.id, role: 'editor' },
      { projectId: projectB, userId: editor.id, role: 'editor' },
      { projectId: projectB, userId: outsider.id, role: 'admin' },
    ]);
    await db.insert(schema.projectSettings).values([{ projectId: projectA }, { projectId: projectB }]);
    const [credential] = await db.insert(schema.projectGatewayCredentials).values({
      projectId: projectA, source: 'encrypted_api_key', lifecycle: 'available', health: 'healthy',
      createdByUserId: admin.id, encryptedSecret: 'synthetic-ciphertext', encryptionNonce: 'synthetic-nonce',
      encryptionTag: 'synthetic-tag', encryptionKeyVersion: 'test', secretFingerprint: randomUUID(),
    }).returning();
    await db.update(schema.projects).set({ currentGatewayCredentialId: credential.id }).where(eq(schema.projects.id, projectA));
    [owned, unowned, foreign, ownedElsewhere] = await Promise.all([
      issueKey({ projectId: projectA, ownerUserId: editor.id, name: 'Owned', model: 'test/language', monthlyCostCapUsd: 12 }),
      issueKey({ projectId: projectA, ownerUserId: peer.id, name: 'Peer key', model: 'test/language' }),
      issueKey({ projectId: projectB, ownerUserId: outsider.id, name: 'Foreign key', model: 'test/language' }),
      issueKey({ projectId: projectB, ownerUserId: editor.id, name: 'Owned elsewhere', model: 'test/language' }),
    ]);
    const collections = await db.insert(schema.knowledgebases).values([
      { projectId: projectA, ownerUserId: editor.id, name: 'Owned knowledge' },
      { projectId: projectA, ownerUserId: peer.id, name: 'Shared knowledge' },
      { projectId: projectB, ownerUserId: outsider.id, name: 'Foreign knowledge' },
    ]).returning();
    [ownedKb, sharedKb, foreignKb] = collections.map((collection) => collection.id);
    await db.insert(schema.kbDocuments).values(collections.map((collection) => ({
      projectId: collection.projectId, kbId: collection.id, filename: `${collection.name}.txt`,
      pathname: `synthetic/${collection.id}`, url: `https://example.test/${collection.id}`,
      contentType: 'text/plain', bytes: 10,
    })));
  });

  afterAll(async () => {
    if (pool) {
      try { await pool.query(`drop schema ${q(schemaName)} cascade`); }
      finally { await pool.end(); }
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('limits editor reads to owned keys and admin reads to their current project', async () => {
    expect(await call(editor, 'keys.list')).toEqual([expect.objectContaining({ id: owned.id })]);
    expect(await call(admin, 'keys.list')).toHaveLength(2);
    expect(await call(admin, 'keys.list', {}, projectB)).toEqual([]);
    await expect(call(editor, 'keys.get', { id: unowned.id })).rejects.toThrow('not_found');
    await expect(call(admin, 'keys.get', { id: foreign.id })).rejects.toThrow('not_found');
    const rows = await call(admin, 'keys.list') as Record<string, unknown>[];
    for (const row of rows) { expect(row).not.toHaveProperty('keyHash'); expect(row).not.toHaveProperty('fullKey'); }
  });

  it('rotates and revokes owned keys while rejecting unowned and wrong-project targets', async () => {
    await expect(call(editor, 'keys.rotate', { id: unowned.id })).rejects.toThrow('forbidden');
    await expect(call(editor, 'keys.revoke', { id: unowned.id })).rejects.toThrow('forbidden');
    await expect(call(admin, 'keys.rotate', { id: foreign.id })).rejects.toThrow('not_found');
    await expect(call(editor, 'keys.rotate', { id: ownedElsewhere.id })).rejects.toThrow('not_found');
    const rotated = await call(editor, 'keys.rotate', { id: owned.id }) as { fullKey: string };
    expect(await verifyKey(owned.fullKey)).toBeNull();
    expect(await verifyKey(rotated.fullKey)).toMatchObject({ id: owned.id, projectId: projectA });
    await call(editor, 'keys.revoke', { id: owned.id });
    expect(await verifyKey(rotated.fullKey)).toBeNull();
    expect((await keyRecord(unowned.id)).status).toBe('active');
    expect((await keyRecord(foreign.id)).status).toBe('active');
    const adminRotation = await call(admin, 'keys.rotate', { id: unowned.id }) as { fullKey: string };
    expect(await verifyKey(adminRotation.fullKey)).toMatchObject({ id: unowned.id });
    await call(admin, 'keys.revoke', { id: unowned.id });
    expect(await verifyKey(adminRotation.fullKey)).toBeNull();
    const audits = await db.select().from(schema.auditLog);
    expect(audits).toHaveLength(4);
    expect(audits.every((entry) => entry.projectId === projectA)).toBe(true);
    for (const secret of [owned.fullKey, unowned.fullKey, rotated.fullKey, adminRotation.fullKey]) {
      expect(JSON.stringify(audits)).not.toContain(secret);
    }
    expect(audits.map((entry) => entry.actor).sort()).toEqual([editor.email, editor.email, admin.email, admin.email].sort());
  });

  it('preserves editor ownership and budget while permitting admin updates', async () => {
    await expect(call(editor, 'keys.update', { id: unowned.id, name: 'No' })).rejects.toThrow('not_found');
    await expect(call(admin, 'keys.update', { id: foreign.id, name: 'No' })).rejects.toThrow('not_found');
    await call(editor, 'keys.update', { id: owned.id, name: 'Edited', monthlyCostCapUsd: null, ownerUserId: peer.id, params: { allowClientPrompt: true } });
    expect(await keyRecord(owned.id)).toMatchObject({ name: 'Edited', monthlyCostCapUsd: 12, ownerUserId: editor.id, params: { allowClientPrompt: true } });
    await call(admin, 'keys.update', { id: owned.id, monthlyCostCapUsd: 25, ownerUserId: peer.id });
    expect(await keyRecord(owned.id)).toMatchObject({ monthlyCostCapUsd: 25, ownerUserId: peer.id });
    await expect(call(editor, 'keys.rotate', { id: owned.id })).rejects.toThrow('forbidden');
    expect((await keyRecord(foreign.id)).name).toBe('Foreign key');
  });

  it('applies console ownership and budget defaults when editors create keys', async () => {
    const created = await call(editor, 'keys.create', {
      name: 'Created through CLI', model: 'test/language', ownerUserId: peer.id, monthlyCostCapUsd: null,
    }) as { fullKey: string };
    const verified = await verifyKey(created.fullKey);
    expect(verified).toMatchObject({ projectId: projectA, monthlyCostCapUsd: 100 });
    expect((await keyRecord(verified!.id)).ownerUserId).toBe(editor.id);
    const adminCreated = await call(admin, 'keys.create', {
      name: 'Admin key', model: 'test/language', ownerUserId: peer.id, monthlyCostCapUsd: null,
    }) as { fullKey: string };
    const verifiedAdmin = await verifyKey(adminCreated.fullKey);
    expect(await keyRecord(verifiedAdmin!.id)).toMatchObject({ ownerUserId: peer.id, monthlyCostCapUsd: null });
  });

  it('requires the current project admin role and preserves the last admin', async () => {
    await expect(call(editor, 'members.role', { userId: peer.id, role: 'admin' })).rejects.toThrow('forbidden');
    await expect(call(admin, 'members.role', { userId: outsider.id, role: 'editor' }, projectB)).rejects.toThrow('forbidden');
    await expect(call(admin, 'members.role', { userId: admin.id, role: 'editor' })).rejects.toThrow('last_project_admin');
    await call(admin, 'members.role', { userId: peer.id, role: 'admin' });
    const [changed] = await db.select().from(schema.projectMemberships).where(and(eq(schema.projectMemberships.projectId, projectA), eq(schema.projectMemberships.userId, peer.id)));
    expect(changed.role).toBe('admin');
    await call(admin, 'members.role', { userId: peer.id, role: 'editor' });
    await expect(call(peer, 'members.list')).rejects.toThrow('forbidden');
  });

  it.each(['membership', 'identity', 'project'] as const)('rejects reads and writes after %s becomes inactive', async (kind) => {
    await call(editor, 'keys.list');
    if (kind === 'membership') await db.update(schema.projectMemberships).set({ status: 'suspended' }).where(and(eq(schema.projectMemberships.userId, editor.id), eq(schema.projectMemberships.projectId, projectA)));
    if (kind === 'identity') await db.update(schema.users).set({ status: 'inactive' }).where(eq(schema.users.id, editor.id));
    if (kind === 'project') await db.update(schema.projects).set({ status: 'suspended' }).where(eq(schema.projects.id, projectA));
    await expect(call(editor, 'keys.list')).rejects.toThrow('forbidden');
    await expect(call(editor, 'keys.revoke', { id: owned.id })).rejects.toThrow('forbidden');
    expect((await keyRecord(owned.id)).status).toBe('active');
  });

  it('enforces KB ownership for documents but shares attachment options within one project', async () => {
    expect(await call(editor, 'knowledgebases.list')).toEqual([expect.objectContaining({ id: ownedKb })]);
    expect(await call(admin, 'knowledgebases.list')).toHaveLength(2);
    const options = await call(editor, 'knowledgebases.options') as { id: string }[];
    expect(options.map((option) => option.id).sort()).toEqual([ownedKb, sharedKb].sort());
    expect(await call(editor, 'knowledgebases.documents', { kbId: ownedKb })).toHaveLength(1);
    await expect(call(editor, 'knowledgebases.documents', { kbId: sharedKb })).rejects.toThrow('forbidden');
    await expect(call(admin, 'knowledgebases.documents', { kbId: foreignKb })).rejects.toThrow('Knowledgebase not found');
    expect(await call(admin, 'knowledgebases.documents', { kbId: sharedKb })).toHaveLength(1);
    const created = await call(editor, 'knowledgebases.create', { name: 'New collection' }) as { id: string };
    const [collection] = await db.select().from(schema.knowledgebases).where(eq(schema.knowledgebases.id, created.id));
    expect(collection).toMatchObject({ projectId: projectA, ownerUserId: editor.id });
    await call(editor, 'keys.update', { id: owned.id, knowledgebaseId: sharedKb });
    expect((await keyRecord(owned.id)).knowledgebaseId).toBe(sharedKb);
    await expect(call(editor, 'keys.update', { id: owned.id, knowledgebaseId: foreignKb })).rejects.toThrow('Knowledgebase not found');
    expect((await keyRecord(owned.id)).knowledgebaseId).toBe(sharedKb);
  });

  it('lists one visible key’s 100 newest logs across sources, filtering before the limit', async () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
    // The peer key's 120 rows are all newer than the owned key's rows, so a key
    // filter applied after the LIMIT would return none of the owned key's logs.
    await db.insert(schema.usageEvents).values([
      ...Array.from({ length: 99 }, (_, i) => ({ projectId: projectA, apiKeyId: owned.id, createdAt: at(i) })),
      { projectId: projectA, apiKeyId: owned.id, source: 'eval_judge' as const, createdAt: at(150) },
      ...Array.from({ length: 120 }, (_, i) => ({ projectId: projectA, apiKeyId: unowned.id, createdAt: at(200 + i) })),
      { projectId: projectA, apiKeyId: null, source: 'kb_ingest' as const, createdAt: at(400) },
    ]);
    const [run] = await db.insert(schema.evalRuns).values({
      projectId: projectA, apiKeyId: owned.id, status: 'completed',
      championModel: 'test/language', challengerModel: 'test/challenger', judgeModel: 'test/judge',
    }).returning();
    await db.insert(schema.evalSamples).values({ projectId: projectA, runId: run.id, status: 'judged', judgedAt: at(160) });

    type Log = { apiKeyId: string | null; source: string; createdAt: Date };
    const logs = await call(editor, 'logs.list', { keyId: owned.id }) as Log[];
    expect(logs).toHaveLength(100);
    expect(logs.every((log) => log.apiKeyId === owned.id)).toBe(true);
    expect(logs.slice(0, 2).map((log) => log.source)).toEqual(['challenger', 'judge']);
    // Newest first; the oldest of the key's 101 rows falls outside the 100.
    expect(logs.map((log) => log.createdAt.getTime())).toEqual(logs.map((log) => log.createdAt.getTime()).sort((a, b) => b - a));
    expect(logs.at(-1)!.createdAt).toEqual(at(1));
    expect(await call(editor, 'logs.list', { keyId: owned.id, source: 'challenger' })).toHaveLength(1);
    expect(await call(editor, 'logs.list', { keyId: owned.id, limit: 5 })).toHaveLength(5);

    await expect(call(editor, 'logs.list', { keyId: unowned.id })).rejects.toThrow('not_found');
    await expect(call(editor, 'logs.list', { keyId: ownedElsewhere.id })).rejects.toThrow('not_found');
    await expect(call(admin, 'logs.list', { keyId: foreign.id })).rejects.toThrow('not_found');
    const peerLogs = await call(admin, 'logs.list', { keyId: unowned.id }) as Log[];
    expect(peerLogs).toHaveLength(100);
    expect(peerLogs.every((log) => log.apiKeyId === unowned.id)).toBe(true);
  });

  it('keeps simultaneous identities isolated across actual database awaits', async () => {
    const viewers = Array.from({ length: 12 }, (_, index) => index % 2 ? editor : peer);
    const results = await Promise.all(viewers.map((user) => call(user, 'keys.list')));
    for (let index = 0; index < results.length; index++) {
      expect(results[index]).toEqual([expect.objectContaining({ id: viewers[index].id === editor.id ? owned.id : unowned.id })]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows one available Cloudflare credential per project', async () => {
    await cloudflareRow(projectA, admin.id);
    expect(await dbError(cloudflareRow(projectA, admin.id))).toMatchObject({
      code: '23505', constraint: 'project_cloudflare_credentials_one_available_idx',
    });
    await expect(cloudflareRow(projectA, admin.id, { ...RETIRED_ENVELOPE, replacedAt: new Date() }))
      .resolves.toMatchObject({ projectId: projectA, lifecycle: 'replaced', encryptedSecret: null });
  });

  it('rejects one available Cloudflare token in two projects', async () => {
    const secretFingerprint = randomUUID();
    const first = await cloudflareRow(projectA, admin.id, { secretFingerprint });
    expect(await dbError(cloudflareRow(projectB, outsider.id, { secretFingerprint }))).toMatchObject({
      code: '23505', constraint: 'project_cloudflare_credentials_fingerprint_idx',
    });
    await db.update(schema.projectCloudflareCredentials)
      .set({ ...RETIRED_ENVELOPE, replacedAt: new Date() })
      .where(eq(schema.projectCloudflareCredentials.id, first.id));
    await expect(cloudflareRow(projectB, outsider.id, { secretFingerprint }))
      .resolves.toMatchObject({ projectId: projectB, lifecycle: 'available' });
  });

  it('rejects a cross-project Cloudflare pointer', async () => {
    const foreignRow = await cloudflareRow(projectB, outsider.id);
    expect(await dbError(db.update(schema.projects)
      .set({ currentCloudflareCredentialId: foreignRow.id })
      .where(eq(schema.projects.id, projectA)))).toMatchObject({
      code: '23503', constraint: 'projects_current_cloudflare_credential_fk',
    });
    // The same pointer is fine on the row's own project.
    await db.update(schema.projects)
      .set({ currentCloudflareCredentialId: foreignRow.id })
      .where(eq(schema.projects.id, projectB));
  });

  it('rejects a malformed Cloudflare account id', async () => {
    for (const accountId of ['0123456789ABCDEF0123456789ABCDEF', '0123', '../../workers/scripts']) {
      expect(await dbError(cloudflareRow(projectA, admin.id, { accountId }))).toMatchObject({
        code: '23514', constraint: 'project_cloudflare_credentials_account_id_check',
      });
    }
  });

  it('requires the envelope on available rows only', async () => {
    expect(await dbError(cloudflareRow(projectA, admin.id, { encryptedSecret: null }))).toMatchObject({
      code: '23514', constraint: 'project_cloudflare_credentials_envelope_check',
    });
    expect(await dbError(cloudflareRow(projectA, admin.id, { lifecycle: 'replaced' }))).toMatchObject({
      code: '23514', constraint: 'project_cloudflare_credentials_envelope_check',
    });
  });

  it('attributes a usage row to at most one credential', async () => {
    const row = await cloudflareRow(projectA, admin.id);
    const foreignRow = await cloudflareRow(projectB, outsider.id);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectA));
    const usage = {
      projectId: projectA, apiKeyId: owned.id, provider: 'cloudflare', model: '@cf/cloudflare/clef', costUsd: '0.000008',
    };
    await expect(db.insert(schema.usageEvents).values({ ...usage, cloudflareCredentialId: row.id }).returning())
      .resolves.toEqual([expect.objectContaining({ cloudflareCredentialId: row.id, gatewayCredentialId: null, costUsd: '0.000008' })]);
    expect(await dbError(db.insert(schema.usageEvents).values({
      ...usage, cloudflareCredentialId: row.id, gatewayCredentialId: project.currentGatewayCredentialId,
    }))).toMatchObject({ code: '23514', constraint: 'usage_events_single_credential_check' });
    expect(await dbError(db.insert(schema.usageEvents).values({ ...usage, cloudflareCredentialId: foreignRow.id })))
      .toMatchObject({ code: '23503', constraint: 'usage_events_cloudflare_credential_fk' });
  });

  it('connects, rotates and disconnects a Cloudflare credential', async () => {
    await expect(connectCloudflare(admin, projectA, CF_TOKEN_ONE, ' 0123456789ABCDEF0123456789ABCDEF '))
      .resolves.toEqual({ ok: true });
    const connected = await projectRecord(projectA);
    expect(connected.cloudflareCredentialRevision).toBe(1);
    const rowA = await credentialRecord(connected.currentCloudflareCredentialId!);
    expect(rowA).toMatchObject({
      projectId: projectA, accountId: CF_ACCOUNT, lifecycle: 'available', health: 'healthy',
      encryptionKeyVersion: 'test-v1', secretLastFour: '0001', createdByUserId: admin.id, lastFailureCode: null,
    });
    expect(rowA.verifiedAt).toBeInstanceOf(Date);
    for (const part of [rowA.encryptedSecret, rowA.encryptionNonce, rowA.encryptionTag]) expect(part).toEqual(expect.any(String));
    expect(rowA.encryptedSecret).not.toContain(CF_TOKEN_ONE);
    const ready = await getProjectCloudflareSummary(projectA);
    expect(ready).toMatchObject({ state: 'ready', isReady: true, credentialId: rowA.id, accountId: CF_ACCOUNT, lastFour: '0001' });
    expect(redactProjectCloudflareSummary(ready, 'editor')).toEqual({
      projectId: projectA, state: 'ready', isReady: true, credentialId: null, accountId: null, lifecycle: null,
      health: null, lastFour: null, connectedAt: null, verifiedAt: null, lastCheckedAt: null, lastFailureCode: null,
    });

    await expect(connectCloudflare(admin, projectA, CF_TOKEN_TWO)).resolves.toEqual({ ok: true });
    const rotated = await projectRecord(projectA);
    expect(rotated.cloudflareCredentialRevision).toBe(2);
    const rowB = await credentialRecord(rotated.currentCloudflareCredentialId!);
    expect(rowB.id).not.toBe(rowA.id);
    expect(rowB).toMatchObject({ lifecycle: 'available', health: 'healthy', secretLastFour: '0002' });
    expect(await credentialRecord(rowA.id)).toMatchObject({ ...RETIRED_ENVELOPE, replacedAt: expect.any(Date) });

    await expect(asUser(admin, () => disconnectProjectCloudflare({ projectId: projectA }))).resolves.toEqual({ ok: true });
    expect(await projectRecord(projectA)).toMatchObject({ currentCloudflareCredentialId: null, cloudflareCredentialRevision: 3 });
    expect(await credentialRecord(rowB.id)).toMatchObject({
      lifecycle: 'disconnected', encryptedSecret: null, encryptionNonce: null, encryptionTag: null,
      disconnectedAt: expect.any(Date),
    });
    await expect(resolveProjectCloudflare(projectA)).rejects.toMatchObject({ provider: 'cloudflare', reason: 'credential_missing' });

    // Idempotent: nothing connected, still audited.
    await expect(asUser(admin, () => disconnectProjectCloudflare({ projectId: projectA }))).resolves.toEqual({ ok: true });
    const audits = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.projectId, projectA)).orderBy(schema.auditLog.createdAt);
    expect(audits.map((entry) => [entry.actor, entry.action, entry.target, entry.after])).toEqual([
      [admin.email, 'cloudflare.connect', rowA.id, { lastFour: '0001', fingerprint: rowA.secretFingerprint }],
      [admin.email, 'cloudflare.rotate', rowB.id, { lastFour: '0002', fingerprint: rowB.secretFingerprint }],
      [admin.email, 'cloudflare.disconnect', rowB.id, { lastFour: '0002', fingerprint: rowB.secretFingerprint }],
      [admin.email, 'cloudflare.disconnect', projectA, null],
    ]);
    for (const secret of [CF_TOKEN_ONE, CF_TOKEN_TWO, CF_ACCOUNT]) expect(JSON.stringify(audits)).not.toContain(secret);
  });

  it('a 401 that lands after a rotation invalidates only the old row', async () => {
    await connectCloudflare(admin, projectA, CF_TOKEN_ONE);
    const snapshotA = await resolveProjectCloudflare(projectA);
    await connectCloudflare(admin, projectA, CF_TOKEN_TWO);
    const rowB = (await projectRecord(projectA)).currentCloudflareCredentialId!;
    expect(rowB).not.toBe(snapshotA.cloudflareCredentialId);

    // The in-flight call made with row A's snapshot fails only now, after the rotation.
    const late = cloudflare401();
    const normalized = await normalizeProjectCloudflareError(snapshotA, late);
    expect(normalized).toBeInstanceOf(ProjectCloudflareUnavailableError);
    expect(normalized).toMatchObject({
      provider: 'cloudflare', reason: 'credential_invalid', cloudflareCredentialId: snapshotA.cloudflareCredentialId, cause: late,
    });
    expect(await credentialRecord(snapshotA.cloudflareCredentialId)).toMatchObject({
      health: 'invalid', lastFailureCode: 'cloudflare_authentication_failed', lifecycle: 'replaced',
    });
    expect(await credentialRecord(rowB)).toMatchObject({ health: 'healthy', lifecycle: 'available', lastFailureCode: null });
    expect((await projectRecord(projectA)).currentCloudflareCredentialId).toBe(rowB);
    expect((await resolveProjectCloudflare(projectA)).cloudflareCredentialId).toBe(rowB);

    // The same failure on a fresh snapshot of the current row takes it out of service.
    const snapshotB = await resolveProjectCloudflare(projectA);
    await normalizeProjectCloudflareError(snapshotB, cloudflare401());
    expect(await credentialRecord(rowB)).toMatchObject({ health: 'invalid', lastFailureCode: 'cloudflare_authentication_failed' });
    await expect(resolveProjectCloudflare(projectA)).rejects.toMatchObject({
      provider: 'cloudflare', reason: 'credential_invalid', cloudflareCredentialId: rowB,
    });
    expect(await getProjectCloudflareSummary(projectA)).toMatchObject({ state: 'attention', isReady: false, health: 'invalid' });
  });

  it('refuses a token another project already uses', async () => {
    await expect(connectCloudflare(admin, projectA, CF_TOKEN_ONE)).resolves.toEqual({ ok: true });
    // The real DrizzleQueryError → pg 23505 cause chain (CCR-1), not a hand-built one.
    await expect(connectCloudflare(outsider, projectB, CF_TOKEN_ONE)).resolves.toEqual({ ok: false, code: 'cloudflare_in_use' });
    expect(await projectRecord(projectB)).toMatchObject({ currentCloudflareCredentialId: null, cloudflareCredentialRevision: 0 });
    expect(await db.select().from(schema.projectCloudflareCredentials)
      .where(eq(schema.projectCloudflareCredentials.projectId, projectB))).toHaveLength(0);
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.projectId, projectB))).toHaveLength(0);

    // Rotating projectA to the same token works: the old row leaves 'available' first.
    await expect(connectCloudflare(admin, projectA, CF_TOKEN_ONE)).resolves.toEqual({ ok: true });
    const rows = await db.select().from(schema.projectCloudflareCredentials)
      .where(eq(schema.projectCloudflareCredentials.projectId, projectA));
    expect(rows.map((row) => row.lifecycle).sort()).toEqual(['available', 'replaced']);
    expect(new Set(rows.map((row) => row.secretFingerprint)).size).toBe(1);
  });

  it('never consults the Vercel credential', async () => {
    await db.update(schema.projectGatewayCredentials).set({ health: 'invalid' })
      .where(eq(schema.projectGatewayCredentials.projectId, projectA));
    await expect(connectCloudflare(admin, projectA, CF_TOKEN_ONE)).resolves.toEqual({ ok: true });

    await expect(resolveProjectCloudflare(projectA)).resolves.toMatchObject({ projectId: projectA, accountId: CF_ACCOUNT });
    expect(await getProjectCloudflareSummary(projectA)).toMatchObject({ state: 'ready', isReady: true });
    expect(await getProjectGatewaySummary(projectA)).toMatchObject({ state: 'attention', isReady: false });
  });

  it('keeps connect and disconnect Admin-only', async () => {
    await expect(connectCloudflare(editor, projectA, CF_TOKEN_ONE)).rejects.toThrow('forbidden');
    await expect(asUser(editor, () => disconnectProjectCloudflare({ projectId: projectA }))).rejects.toThrow('forbidden');
    expect(await db.select().from(schema.projectCloudflareCredentials)).toHaveLength(0);
    expect(await projectRecord(projectA)).toMatchObject({ currentCloudflareCredentialId: null, cloudflareCredentialRevision: 0 });
  });

  it('shows Cloudflare credential metadata to Admins and only readiness to Editors through the CLI', async () => {
    const row = await seedCloudflare(projectA, admin.id);
    expect(await call(admin, 'cloudflare.status')).toMatchObject({
      projectId: projectA, state: 'ready', isReady: true, credentialId: row.id, accountId: CF_ACCOUNT,
      lifecycle: 'available', health: 'healthy', lastFour: 'abcd',
    });
    expect(await call(editor, 'cloudflare.status')).toEqual({ projectId: projectA, state: 'ready', isReady: true, ...CF_NULLS });
    // admin is only an Editor of project B, which has no Cloudflare credential.
    expect(await call(admin, 'cloudflare.status', {}, projectB)).toEqual({ projectId: projectB, state: 'not_connected', isReady: false, ...CF_NULLS });
    await expect(call(outsider, 'cloudflare.status')).rejects.toThrow('forbidden');
    await db.update(schema.projectCloudflareCredentials)
      .set({ health: 'invalid', lastFailureCode: 'cloudflare_authentication_failed' })
      .where(eq(schema.projectCloudflareCredentials.id, row.id));
    expect(await call(editor, 'cloudflare.status')).toEqual({ projectId: projectA, state: 'attention', isReady: false, ...CF_NULLS });
    expect(await call(admin, 'cloudflare.status')).toMatchObject({
      state: 'attention', isReady: false, health: 'invalid', lastFailureCode: 'cloudflare_authentication_failed',
    });
  });

  it('keeps Cloudflare connect and disconnect Admin-only through the CLI', async () => {
    const row = await seedCloudflare(projectA, admin.id);
    await expect(call(editor, 'cloudflare.connect', { accountId: CF_ACCOUNT, apiToken: CF_TOKEN_ONE })).rejects.toThrow('forbidden');
    await expect(call(editor, 'cloudflare.disconnect')).rejects.toThrow('forbidden');
    // admin is only an Editor of project B.
    await expect(call(admin, 'cloudflare.connect', { accountId: CF_ACCOUNT, apiToken: CF_TOKEN_ONE }, projectB)).rejects.toThrow('forbidden');
    await expect(call(admin, 'cloudflare.disconnect', {}, projectB)).rejects.toThrow('forbidden');
    expect(await db.select().from(schema.projectCloudflareCredentials)).toEqual([expect.objectContaining({ id: row.id, lifecycle: 'available' })]);
    expect((await projectRecord(projectA)).currentCloudflareCredentialId).toBe(row.id);
    expect(await db.select().from(schema.auditLog)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('saves nothing through the CLI when the account id is malformed, the token is rejected, or Cloudflare cannot be reached', async () => {
    const fetchMock = vi.mocked(fetch);
    try {
      await expect(call(admin, 'cloudflare.connect', { accountId: 'not-a-cloudflare-account-id', apiToken: CF_TOKEN_ONE }))
        .rejects.toThrow('cloudflare_invalid_account_id');
      expect(fetchMock).not.toHaveBeenCalled(); // normalised before any network call
      // The file's forbid-all stub throws synchronously; validateCloudflareCredential never throws.
      const error = await call(admin, 'cloudflare.connect', { accountId: CF_ACCOUNT, apiToken: CF_TOKEN_ONE }).catch((e: unknown) => e);
      expect((error as Error).message).toBe('cloudflare_unreachable');
      const response = cliErrorResponse(error);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'cloudflare_unreachable', message: 'Cloudflare could not be reached to validate the credential. Try again.' } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe(CF_SEARCH_URL);
      // A real-world network failure (a rejected promise) maps the same way.
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(call(admin, 'cloudflare.connect', { accountId: CF_ACCOUNT, apiToken: CF_TOKEN_ONE })).rejects.toThrow('cloudflare_unreachable');
      // Cloudflare refusing the token is cloudflare_invalid (anchored: the account-id code shares the prefix).
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
      await expect(call(admin, 'cloudflare.connect', { accountId: CF_ACCOUNT, apiToken: CF_TOKEN_ONE })).rejects.toThrow(/^cloudflare_invalid$/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(await db.select().from(schema.projectCloudflareCredentials)).toEqual([]);
      expect(await projectRecord(projectA)).toMatchObject({ currentCloudflareCredentialId: null, cloudflareCredentialRevision: 0 });
      expect(await db.select().from(schema.auditLog)).toEqual([]);
    } finally {
      fetchMock.mockReset();
    }
  });

  it('connects, rotates and disconnects Cloudflare through the CLI without storing or auditing the token', async () => {
    // The crypto env (key version test-v1) is stubbed once in beforeAll.
    const fetchMock = vi.mocked(fetch);
    try {
      fetchMock.mockImplementationOnce(cfOk);
      expect(await call(admin, 'cloudflare.connect', { accountId: ` ${CF_ACCOUNT.toUpperCase()} `, apiToken: ` ${CF_TOKEN_ONE} ` })).toEqual({ ok: true });
      const [first] = await db.select().from(schema.projectCloudflareCredentials);
      expect(first).toMatchObject({
        projectId: projectA, accountId: CF_ACCOUNT, lifecycle: 'available', health: 'healthy',
        secretLastFour: '0001', encryptionKeyVersion: 'test-v1', createdByUserId: admin.id,
      });
      expect(first.secretFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(await projectRecord(projectA)).toMatchObject({ currentCloudflareCredentialId: first.id, cloudflareCredentialRevision: 1 });
      expect(await call(editor, 'cloudflare.status')).toEqual({ projectId: projectA, state: 'ready', isReady: true, ...CF_NULLS });

      fetchMock.mockImplementationOnce(cfOk); // rotate
      expect(await call(admin, 'cloudflare.connect', { accountId: CF_ACCOUNT, apiToken: CF_TOKEN_TWO })).toEqual({ ok: true });
      const rows = await db.select().from(schema.projectCloudflareCredentials);
      expect(rows).toHaveLength(2);
      const replaced = rows.find((row) => row.id === first.id)!;
      const current = rows.find((row) => row.id !== first.id)!;
      expect(replaced).toMatchObject({ lifecycle: 'replaced', encryptedSecret: null, encryptionNonce: null, encryptionTag: null });
      expect(replaced.replacedAt).toBeInstanceOf(Date);
      expect(current).toMatchObject({ lifecycle: 'available', secretLastFour: '0002' });

      fetchMock.mockImplementationOnce(cfOk); // the same token on project B, whose Admin is outsider
      const inUse = await call(outsider, 'cloudflare.connect', { accountId: CF_ACCOUNT, apiToken: CF_TOKEN_TWO }, projectB).catch((e: unknown) => e);
      expect((inUse as Error).message).toBe('cloudflare_in_use');
      const response = cliErrorResponse(inUse);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: 'cloudflare_in_use', message: 'This Cloudflare API token is already in use by another project.' } });
      expect(await db.select().from(schema.projectCloudflareCredentials).where(eq(schema.projectCloudflareCredentials.projectId, projectB))).toEqual([]);
      expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.projectId, projectB))).toEqual([]);

      expect(await call(admin, 'cloudflare.disconnect')).toEqual({ ok: true });
      const disconnected = await credentialRecord(current.id);
      expect(disconnected).toMatchObject({ lifecycle: 'disconnected', encryptedSecret: null, encryptionNonce: null, encryptionTag: null });
      expect(disconnected.disconnectedAt).toBeInstanceOf(Date);
      expect(await projectRecord(projectA)).toMatchObject({ currentCloudflareCredentialId: null, cloudflareCredentialRevision: 3 });
      expect(await call(admin, 'cloudflare.disconnect')).toEqual({ ok: true }); // idempotent
      expect(await call(admin, 'cloudflare.status')).toMatchObject({ state: 'not_connected', isReady: false, credentialId: null });

      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.projectId, projectA));
      expect(audits.map((entry) => entry.action).sort()).toEqual(['cloudflare.connect', 'cloudflare.disconnect', 'cloudflare.disconnect', 'cloudflare.rotate']);
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'cloudflare.connect', actor: admin.email, target: first.id, after: { lastFour: '0001', fingerprint: first.secretFingerprint } }),
        expect.objectContaining({ action: 'cloudflare.rotate', target: current.id, after: { lastFour: '0002', fingerprint: current.secretFingerprint } }),
        expect.objectContaining({ action: 'cloudflare.disconnect', target: current.id, after: { lastFour: '0002', fingerprint: current.secretFingerprint } }),
        expect.objectContaining({ action: 'cloudflare.disconnect', target: projectA, after: null }),
      ]));
      const stored = JSON.stringify([await db.select().from(schema.projectCloudflareCredentials), await db.select().from(schema.auditLog)]);
      for (const secret of [CF_TOKEN_ONE, CF_TOKEN_TWO]) expect(stored).not.toContain(secret);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const [url] of fetchMock.mock.calls) expect(String(url)).toBe(CF_SEARCH_URL);
      expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${CF_TOKEN_ONE}`);
    } finally {
      fetchMock.mockReset();
    }
  });
});
