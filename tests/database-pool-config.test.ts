import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildDatabasePoolConfig } from '@/db/pool-config';

const azureUrl =
  'postgresql://sophy_app:secret@sophy.postgres.database.azure.com:6432/sophy?sslmode=verify-full';

describe('buildDatabasePoolConfig', () => {
  it('keeps certificate verification under application control', () => {
    const config = buildDatabasePoolConfig({
      connectionString: `${azureUrl}&ssl=0&uselibpqcompat=true`,
      max: 5,
      isProduction: true,
      allowInsecureTls: false,
      expectedHostSuffix: '.postgres.database.azure.com',
    });

    expect(config.connectionString).not.toContain('sslmode');
    expect(config.connectionString).not.toContain('ssl=');
    expect(config.connectionString).not.toContain('uselibpqcompat');
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.max).toBe(5);
    const client = new Client(config);
    expect(client.host).toBe('sophy.postgres.database.azure.com');
    expect(client.port).toBe(6432);
  });

  it('rejects a database host outside the expected provider', () => {
    expect(() =>
      buildDatabasePoolConfig({
        connectionString:
          'postgresql://postgres:secret@old.pooler.supabase.com:6543/postgres?sslmode=verify-full',
        max: 5,
        isProduction: true,
        allowInsecureTls: false,
        expectedHostSuffix: '.postgres.database.azure.com',
      }),
    ).toThrow('DATABASE_EXPECTED_HOST_SUFFIX');
  });

  it('always rejects the old provider in production when the suffix variable is absent', () => {
    expect(() =>
      buildDatabasePoolConfig({
        connectionString:
          'postgresql://postgres:secret@old.pooler.supabase.com:6543/postgres?sslmode=verify-full',
        max: 5,
        isProduction: true,
        allowInsecureTls: false,
      }),
    ).toThrow('DATABASE_EXPECTED_HOST_SUFFIX');
  });

  it('rejects a production suffix that does not identify Azure PostgreSQL', () => {
    expect(() =>
      buildDatabasePoolConfig({
        connectionString: azureUrl,
        max: 5,
        isProduction: true,
        allowInsecureTls: false,
        expectedHostSuffix: '.pooler.supabase.com',
      }),
    ).toThrow('must identify Azure PostgreSQL');
  });

  it.each([
    'postgresql://user:secret@sophy.postgres.database.azure.com:6432/sophy?sslmode=disable',
    'postgresql://user:secret@sophy.postgres.database.azure.com:6432/sophy?sslmode=no-verify',
  ])('rejects an insecure production URL', (connectionString) => {
    expect(() =>
      buildDatabasePoolConfig({
        connectionString,
        max: 5,
        isProduction: true,
        allowInsecureTls: false,
      }),
    ).toThrow('verified TLS');
  });

  it('allows explicit plaintext connections for local PostgreSQL', () => {
    const config = buildDatabasePoolConfig({
      connectionString: 'postgresql://user:secret@localhost:5432/sophy?sslmode=disable',
      max: 2,
      isProduction: false,
      allowInsecureTls: false,
    });

    expect(config.ssl).toBeUndefined();
    expect(config.connectionString).not.toContain('sslmode');
  });

  it('does not expose a password when the URL is malformed', () => {
    const secret = 'do-not-print-this-password';
    let message = '';
    try {
      buildDatabasePoolConfig({
        connectionString: `postgresql://user:${secret}@localhost:invalid/sophy`,
        max: 2,
        isProduction: false,
        allowInsecureTls: false,
      });
    } catch (error) {
      message = String(error);
    }

    expect(message).toBe('Error: DATABASE_URL is invalid or contains a connection override.');
    expect(message).not.toContain(secret);
  });

  it('rejects query parameters that override the checked host and port', () => {
    expect(() =>
      buildDatabasePoolConfig({
        connectionString: `${azureUrl}&host=old.pooler.supabase.com&port=6543`,
        max: 5,
        isProduction: true,
        allowInsecureTls: false,
      }),
    ).toThrow('connection override');
  });
});
