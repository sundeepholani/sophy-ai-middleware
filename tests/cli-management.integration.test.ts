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
import previousSnapshot from '../drizzle/meta/0012_snapshot.json';

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
import { dispatchCliOperation } from '@/lib/admin/cli-operations';
import { withCliIdentity } from '@/lib/auth/cli-session';
import { issueKey, verifyKey } from '@/lib/auth/api-key';

const url = process.env.SOPHY_TEST_DATABASE_URL;
const schemaName = `cli_management_${randomUUID().replaceAll('-', '')}`;
const tableNames = [
  'users', 'projects', 'project_memberships', 'project_invitations',
  'project_gateway_credentials', 'project_settings', 'knowledgebases',
  'kb_documents', 'api_keys', 'eval_runs', 'audit_log',
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

describe.skipIf(!url)('CLI management on real PostgreSQL', () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/sophy_test') {
      throw new Error('Management integration tests require a local synthetic sophy_test database');
    }
    vi.stubEnv('KEY_HASH_PEPPER', 'synthetic-management-test-pepper');
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
    const migration = readFileSync(new URL('../drizzle/0013_email_otp_cli_sessions.sql', import.meta.url), 'utf8');
    await pool.query(migration.replaceAll('"public".', `${q(schemaName)}.`));
  });

  beforeEach(async () => {
    await pool.query(`truncate ${[...tableNames, 'login_challenges', 'cli_sessions'].map(q).join(',')} cascade`);
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

  it('keeps simultaneous identities isolated across actual database awaits', async () => {
    const viewers = Array.from({ length: 12 }, (_, index) => index % 2 ? editor : peer);
    const results = await Promise.all(viewers.map((user) => call(user, 'keys.list')));
    for (let index = 0; index < results.length; index++) {
      expect(results[index]).toEqual([expect.objectContaining({ id: viewers[index].id === editor.id ? owned.id : unowned.id })]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
