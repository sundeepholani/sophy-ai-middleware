/**
 * Real PostgreSQL locking tests. Opt in with SOPHY_TEST_DATABASE_URL pointing to
 * a localhost database named sophy_test. Each run uses and drops its own schema.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import previousSnapshot from '../drizzle/meta/0012_snapshot.json';

const dbRef = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@/db/client', () => ({ getDb: () => dbRef.current }));
import { consumeOtp, createOtpChallenge } from '@/lib/auth/otp';
import { createCliSession, resolveCliSession, revokeCliSession } from '@/lib/auth/cli-session';
import { hashToken } from '@/lib/auth/magic-link';
import { purgeExpiredAuthentication } from '@/lib/auth/maintenance';

const url = process.env.SOPHY_TEST_DATABASE_URL;
const schemaName = `otp_test_${randomUUID().replaceAll('-', '')}`;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

type SnapshotTable = {
  name: string;
  columns: Record<string, { name: string; type: string; primaryKey: boolean; notNull: boolean; default?: string }>;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  indexes: Record<string, { name: string; isUnique: boolean; columns: Array<{ expression: string }>; where?: string }>;
  foreignKeys: Record<string, { name: string; tableFrom: string; tableTo: string; columnsFrom: string[]; columnsTo: string[]; onDelete: string }>;
  checkConstraints: Record<string, { name: string; value: string }>;
};
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function makeChallenge(email = `otp-${randomUUID()}@example.test`, next?: string) {
  const id = randomUUID();
  const code = await createOtpChallenge(id, email, next);
  expect(code).toMatch(/^\d{6}$/);
  return { id, code: code!, email };
}
async function seedUser(status: 'active' | 'inactive' = 'active') {
  const [user] = await db.insert(schema.users).values({ email: `user-${randomUUID()}@example.test`, status }).returning();
  return user;
}

describe.skipIf(!url)('email OTP and CLI sessions on real PostgreSQL', () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/sophy_test') {
      throw new Error('Use only a local synthetic sophy_test database for auth integration tests');
    }
    vi.stubEnv('SESSION_PASSWORD', 'synthetic-otp-test-password-with-more-than-32-characters');
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`create schema ${q(schemaName)}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, max: 12, options: `-c search_path=${schemaName}` });
    db = drizzle(pool, { schema });
    dbRef.current = db;
    const names = ['users', 'projects', 'project_memberships', 'project_settings', 'project_invitations', 'audit_log'];
    const tables = names.map((name) => (previousSnapshot.tables as unknown as Record<string, SnapshotTable>)[`public.${name}`]);
    // Use the actual previous schema metadata; irrelevant AI/vector tables are
    // omitted so these auth tests do not depend on a pgvector installation.
    for (const table of tables) {
      const definitions = Object.values(table.columns).map((c) => `${q(c.name)} ${c.type}${c.default === undefined ? '' : ` default ${c.default}`}${c.notNull ? ' not null' : ''}${c.primaryKey ? ' primary key' : ''}`);
      for (const pk of Object.values(table.compositePrimaryKeys)) definitions.push(`primary key (${pk.columns.map(q).join(',')})`);
      for (const check of Object.values(table.checkConstraints)) definitions.push(`constraint ${q(check.name)} check (${check.value})`);
      await pool.query(`create table ${q(table.name)} (${definitions.join(',')})`);
      for (const index of Object.values(table.indexes)) {
        await pool.query(`create ${index.isUnique ? 'unique ' : ''}index ${q(index.name)} on ${q(table.name)} (${index.columns.map((c) => q(c.expression)).join(',')})${index.where ? ` where ${index.where}` : ''}`);
      }
    }
    for (const table of tables) for (const fk of Object.values(table.foreignKeys)) {
      if (names.includes(fk.tableTo)) await pool.query(`alter table ${q(fk.tableFrom)} add constraint ${q(fk.name)} foreign key (${fk.columnsFrom.map(q).join(',')}) references ${q(fk.tableTo)} (${fk.columnsTo.map(q).join(',')}) on delete ${fk.onDelete}`);
    }
    const migration = readFileSync(new URL('../drizzle/0013_email_otp_cli_sessions.sql', import.meta.url), 'utf8');
    await pool.query(migration.replaceAll('"public".', `${q(schemaName)}.`));
  });
  afterAll(async () => {
    if (pool) { await pool.query(`drop schema ${q(schemaName)} cascade`); await pool.end(); }
    vi.unstubAllEnvs();
  });

  it('redeems a code exactly once under concurrent verification', async () => {
    const challenge = await makeChallenge();
    const results = await Promise.all(Array.from({ length: 8 }, () => consumeOtp(challenge.id, challenge.code)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const [record] = await db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.id, challenge.id));
    expect(record.attempts).toBe(1);
    expect(record.consumedAt).not.toBeNull();
  });
  it('enforces the five-attempt budget atomically and rejects the correct code after lockout', async () => {
    const challenge = await makeChallenge();
    const wrong = challenge.code === '000000' ? '000001' : '000000';
    expect(await Promise.all(Array.from({ length: 8 }, () => consumeOtp(challenge.id, wrong)))).toEqual(Array(8).fill(null));
    expect(await consumeOtp(challenge.id, challenge.code)).toBeNull();
    const [record] = await db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.id, challenge.id));
    expect(record.attempts).toBe(5);
    expect(record.consumedAt).not.toBeNull();
  });
  it('rejects expired challenges without creating an identity', async () => {
    const challenge = await makeChallenge();
    await db.update(schema.loginChallenges).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(schema.loginChallenges.id, challenge.id));
    expect(await consumeOtp(challenge.id, challenge.code)).toBeNull();
    expect(await db.select().from(schema.users).where(eq(schema.users.email, challenge.email))).toHaveLength(0);
  });
  it('serializes simultaneous resend requests and invalidates the previous code on allowed resend', async () => {
    const challenge = await makeChallenge();
    expect(await createOtpChallenge(randomUUID(), challenge.email)).toBeNull();
    await db.update(schema.loginChallenges).set({ createdAt: new Date(Date.now() - 61_000) }).where(eq(schema.loginChallenges.id, challenge.id));
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const codes = await Promise.all(ids.map((id) => createOtpChallenge(id, challenge.email)));
    expect(codes.filter(Boolean)).toHaveLength(1);
    expect(await consumeOtp(challenge.id, challenge.code)).toBeNull();
    const winner = codes.findIndex(Boolean);
    expect(await consumeOtp(ids[winner], codes[winner]!)).not.toBeNull();
  });
  it('limits issued codes per email even when each resend waits a minute', async () => {
    const email = `rate-${randomUUID()}@example.test`;
    for (let i = 0; i < 5; i++) {
      await makeChallenge(email);
      await db.update(schema.loginChallenges).set({ createdAt: sql`${schema.loginChallenges.createdAt} - interval '61 seconds'` }).where(eq(schema.loginChallenges.email, email));
    }
    expect(await createOtpChallenge(randomUUID(), email)).toBeNull();
  });
  it('creates one personal project for verified signup and keeps existing users on their current projects', async () => {
    const challenge = await makeChallenge();
    const user = await consumeOtp(challenge.id, challenge.code);
    const [identity] = await db.select().from(schema.users).where(eq(schema.users.id, user!.id));
    const memberships = await db.select().from(schema.projectMemberships).where(eq(schema.projectMemberships.userId, user!.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ role: 'admin', projectId: identity.defaultProjectId });
    await db.update(schema.loginChallenges).set({ createdAt: new Date(Date.now() - 61_000) }).where(eq(schema.loginChallenges.id, challenge.id));
    const second = await makeChallenge(challenge.email);
    expect((await consumeOtp(second.id, second.code))?.id).toBe(user!.id);
    expect(await db.select().from(schema.projectMemberships).where(eq(schema.projectMemberships.userId, user!.id))).toHaveLength(1);
  });
  it('never signs in or reactivates an inactive identity', async () => {
    const inactive = await seedUser('inactive');
    expect(await createOtpChallenge(randomUUID(), inactive.email)).toBeNull();
    const active = await seedUser();
    const challenge = await makeChallenge(active.email);
    await db.update(schema.users).set({ status: 'inactive' }).where(eq(schema.users.id, active.id));
    expect(await consumeOtp(challenge.id, challenge.code)).toBeNull();
  });
  it('verifies new invitees without creating My Project or accepting membership', async () => {
    const inviter = await seedUser();
    const [project] = await db.insert(schema.projects).values({ name: 'Invited', slug: randomUUID(), createdByUserId: inviter.id }).returning();
    const email = `invite-${randomUUID()}@example.test`;
    const token = randomUUID();
    const [invitation] = await db.insert(schema.projectInvitations).values({ projectId: project.id, email, role: 'editor', invitedByUserId: inviter.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) }).returning();
    const next = `/admin/invitations/accept?token=${token}`;
    expect(await createOtpChallenge(randomUUID(), 'different@example.test', next)).toBeNull();
    const challenge = await makeChallenge(email, next);
    const user = await consumeOtp(challenge.id, challenge.code);
    const [identity] = await db.select().from(schema.users).where(eq(schema.users.id, user!.id));
    expect(identity.defaultProjectId).toBeNull();
    expect(await db.select().from(schema.projectMemberships).where(eq(schema.projectMemberships.userId, user!.id))).toHaveLength(0);
    const [remaining] = await db.select().from(schema.projectInvitations).where(eq(schema.projectInvitations.id, invitation.id));
    expect(remaining.acceptedAt).toBeNull();
  });
  it('stores only CLI token hashes and rejects revocation, expiry and deactivation immediately', async () => {
    const user = await seedUser();
    const credential = await createCliSession(user.id);
    const auth = `Bearer ${credential.token}`;
    const identity = await resolveCliSession(auth);
    expect(identity?.userId).toBe(user.id);
    const [stored] = await db.select().from(schema.cliSessions).where(eq(schema.cliSessions.id, identity!.sessionId));
    expect(stored.tokenHash).toBe(hashToken(credential.token));
    expect(stored.tokenHash).not.toContain(credential.token);
    await revokeCliSession(identity!.sessionId, user.id);
    expect(await resolveCliSession(auth)).toBeNull();
    const expired = await createCliSession(user.id);
    await db.update(schema.cliSessions).set({ expiresAt: new Date(Date.now() - 1) }).where(and(eq(schema.cliSessions.userId, user.id), eq(schema.cliSessions.tokenHash, hashToken(expired.token))));
    expect(await resolveCliSession(`Bearer ${expired.token}`)).toBeNull();
    const active = await createCliSession(user.id);
    await db.update(schema.users).set({ status: 'inactive' }).where(eq(schema.users.id, user.id));
    expect(await resolveCliSession(`Bearer ${active.token}`)).toBeNull();
  });
  it('bounds retention cleanup while preserving recent rate history and active sessions', async () => {
    const user = await seedUser();
    const now = Date.now();
    const old = new Date(now - 25 * 3600_000);
    const recent = new Date(now - 30 * 60_000);
    const future = new Date(now + 3600_000);
    const oldIds = Array.from({ length: 502 }, () => randomUUID());
    const recentId = randomUUID();
    await db.insert(schema.loginChallenges).values([
      ...oldIds.map((id) => ({ id, email: user.email, codeHash: 'not-a-live-code', createdAt: old, expiresAt: old, consumedAt: old })),
      { id: recentId, email: user.email, codeHash: 'not-a-live-code', createdAt: recent, expiresAt: recent, consumedAt: recent },
    ]);
    const live = await makeChallenge();
    const [activeSession, recentlyExpired, recentlyRevoked, expiredSession, revokedSession] = await db.insert(schema.cliSessions).values([
      { userId: user.id, tokenHash: randomUUID(), expiresAt: future, createdAt: old },
      { userId: user.id, tokenHash: randomUUID(), expiresAt: recent },
      { userId: user.id, tokenHash: randomUUID(), expiresAt: future, revokedAt: recent },
      { userId: user.id, tokenHash: randomUUID(), expiresAt: old },
      { userId: user.id, tokenHash: randomUUID(), expiresAt: future, revokedAt: old },
    ]).returning();
    expect(await purgeExpiredAuthentication()).toEqual({ challenges: 500, sessions: 2 });
    expect(await db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.email, user.email))).toHaveLength(3);
    expect(await db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.id, recentId))).toHaveLength(1);
    expect(await consumeOtp(live.id, live.code)).not.toBeNull();
    for (const session of [activeSession, recentlyExpired, recentlyRevoked]) {
      expect(await db.select().from(schema.cliSessions).where(eq(schema.cliSessions.id, session.id))).toHaveLength(1);
    }
    for (const session of [expiredSession, revokedSession]) {
      expect(await db.select().from(schema.cliSessions).where(eq(schema.cliSessions.id, session.id))).toHaveLength(0);
    }
    expect(await purgeExpiredAuthentication()).toEqual({ challenges: 2, sessions: 0 });
  });

});
