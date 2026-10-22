import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// A minimal stand-in for the two Drizzle chains resolveCliSession uses:
// select().from().innerJoin().where().limit() and update().set().where().returning().
const db = vi.hoisted(() => ({
  selected: [] as unknown[],
  updated: [] as unknown[],
  updates: [] as Array<{ values: Record<string, unknown>; where: unknown }>,
}));
vi.mock('@/db/client', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => db.selected }) }) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          db.updates.push({ values, where });
          return { returning: async () => db.updated };
        },
      }),
    }),
  }),
}));

import {
  CLI_SESSION_RENEW_AFTER_SECONDS, CLI_SESSION_TTL_SECONDS, renewedCliSessionExpiry, resolveCliSession,
} from '@/lib/auth/cli-session';

const DAY = 86_400_000;
const TOKEN = `Bearer sophy_cli_${'a'.repeat(43)}`;
const identity = (expiresAt: Date) => ({ userId: 'u', email: 'u@example.test', sessionId: 's', expiresAt });

beforeEach(() => {
  db.selected = [];
  db.updated = [];
  db.updates = [];
});

describe('CLI session sliding expiry', () => {
  it('uses a 30-day window renewed at most once a day', () => {
    expect(CLI_SESSION_TTL_SECONDS).toBe(30 * 86_400);
    expect(CLI_SESSION_RENEW_AFTER_SECONDS).toBe(86_400);
    const now = new Date('2026-10-22T00:00:00Z');
    const full = new Date(now.getTime() + 30 * DAY);
    expect(renewedCliSessionExpiry(new Date(now.getTime() + 2 * DAY), now)).toEqual(full);
    expect(renewedCliSessionExpiry(new Date(full.getTime() - DAY - 1), now)).toEqual(full);
    // Within the throttle window: no write.
    expect(renewedCliSessionExpiry(new Date(full.getTime() - DAY), now)).toBeNull();
    expect(renewedCliSessionExpiry(new Date(full.getTime() - 60_000), now)).toBeNull();
    expect(renewedCliSessionExpiry(full, now)).toBeNull();
  });

  it('extends a session on use to 30 days from now', async () => {
    db.selected = [identity(new Date(Date.now() + 3 * DAY))];
    const before = Date.now();
    const renewed = new Date(before + 30 * DAY);
    db.updated = [{ expiresAt: renewed }];
    const resolved = await resolveCliSession(TOKEN);
    expect(db.updates).toHaveLength(1);
    const written = db.updates[0].values.expiresAt as Date;
    expect(written.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(written.getTime()).toBeLessThanOrEqual(Date.now() + 30 * DAY);
    expect(resolved?.expiresAt).toBe(renewed);
  });

  it('skips the write while the stored expiry is within a day of the fresh window', async () => {
    const stored = new Date(Date.now() + 29.5 * DAY);
    db.selected = [identity(stored)];
    const resolved = await resolveCliSession(TOKEN);
    expect(db.updates).toHaveLength(0);
    expect(resolved?.expiresAt).toBe(stored);
  });

  it('does not renew when the caller opts out (logout)', async () => {
    db.selected = [identity(new Date(Date.now() + DAY))];
    expect(await resolveCliSession(TOKEN, { renew: false })).not.toBeNull();
    expect(db.updates).toHaveLength(0);
  });

  it('never touches expired, revoked or unknown sessions', async () => {
    // The lookup filters out revoked/expired rows, so nothing is returned and nothing is written.
    db.selected = [];
    expect(await resolveCliSession(TOKEN)).toBeNull();
    expect(db.updates).toHaveLength(0);
  });

  it('guards the renewal write against a concurrent logout or lapse', async () => {
    const stored = new Date(Date.now() + DAY);
    db.selected = [identity(stored)];
    db.updated = []; // the guarded UPDATE matched no row
    const resolved = await resolveCliSession(TOKEN);
    expect(resolved?.expiresAt).toBe(stored);
    const { sql } = new PgDialect().sqlToQuery(db.updates[0].where as SQL);
    expect(sql).toContain('"cli_sessions"."revoked_at" is null');
    expect(sql).toContain('"cli_sessions"."expires_at" >');
    expect(sql).toContain('"cli_sessions"."expires_at" <');
  });
});
