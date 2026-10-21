import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Migration 0014 runs against the production database while the current build still serves
 * traffic, inside drizzle's single migration transaction, so every lock it takes is held until
 * commit. Its hand edits (see the SQL header) keep that safe; this pins them so a regenerated
 * 0014 cannot silently drop them. tests/cli-management.integration.test.ts applies the same file
 * to a real PostgreSQL schema.
 */
const SQL = readFileSync(
  new URL('../drizzle/0014_project_cloudflare_credentials.sql', import.meta.url),
  'utf8',
);
/** Statements as drizzle's migrator sends them, with comment lines removed. */
const statements = SQL.split('--> statement-breakpoint').map((chunk) =>
  chunk
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim(),
);
const touches = (statement: string, table: string) =>
  new RegExp(`(ALTER TABLE|ON|REFERENCES) ("public"\\.)?"${table}"`).test(statement);

describe('migration 0014 locking', () => {
  it('fails fast instead of queueing behind a long transaction', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s';");
  });

  it('locks users first, before anything touches it', () => {
    // An OTP sign-up inserts its users row, then its projects row. The creator FK needs SHARE ROW
    // EXCLUSIVE on users; taking it after projects is locked could deadlock that sign-up.
    expect(statements[1]).toBe('LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE;');
    const first = statements.findIndex((s) => touches(s, 'users'));
    expect(first).toBeGreaterThan(2);
  });

  it('locks usage_events before projects, before touching either', () => {
    // A usage INSERT locks usage_events, then projects for its FK check: taking projects first
    // can deadlock it, and recordUsage would then drop the usage row.
    expect(statements[2]).toBe('LOCK TABLE "usage_events", "projects" IN ACCESS EXCLUSIVE MODE;');
    const first = statements.findIndex((s) => touches(s, 'projects') || touches(s, 'usage_events'));
    expect(first).toBeGreaterThan(2);
  });

  it('adds the usage_events constraints NOT VALID, so they do not rescan existing rows', () => {
    const added = statements.filter((s) => s.startsWith('ALTER TABLE "usage_events" ADD CONSTRAINT'));
    expect(added.map((s) => /ADD CONSTRAINT "([^"]+)"/.exec(s)?.[1])).toEqual([
      'usage_events_cloudflare_credential_fk',
      'usage_events_single_credential_check',
    ]);
    for (const statement of added) expect(statement).toMatch(/ NOT VALID;$/);
  });
});
