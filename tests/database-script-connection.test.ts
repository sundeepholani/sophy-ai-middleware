import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  databaseIdentity,
  secureConnectionConfig,
} from '../scripts/database/connection.mjs';

describe('database migration connection helpers', () => {
  it('does not expose a password from a malformed secure connection URL', () => {
    const secret = 'do-not-print-this-password';
    expect(() =>
      secureConnectionConfig(
        `postgresql://user:${secret}@localhost:invalid/sophy`,
        {
          label: 'Target database',
          allowInsecureTls: false,
          applicationName: 'test',
        },
      ),
    ).toThrow('Target database is invalid or contains a connection override.');

    try {
      secureConnectionConfig(
        `postgresql://user:${secret}@localhost:invalid/sophy`,
        {
          label: 'Target database',
          allowInsecureTls: false,
          applicationName: 'test',
        },
      );
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('does not expose a password from a malformed identity URL', () => {
    const secret = 'do-not-print-this-password';
    try {
      databaseIdentity(`postgresql://user:${secret}@localhost:invalid/sophy`);
      throw new Error('Expected databaseIdentity to reject the malformed URL.');
    } catch (error) {
      expect(String(error)).toBe(
        'Error: Database connection string is invalid or contains a connection override.',
      );
      expect(String(error)).not.toContain(secret);
    }
  });

  it('uses the decoded database name for connection identity checks', () => {
    const plain = databaseIdentity(
      'postgresql://user:secret@target.example.com:5432/sophy?sslmode=verify-full',
    );
    const encoded = databaseIdentity(
      'postgresql://user:secret@target.example.com:5432/%73ophy?sslmode=verify-full',
    );

    expect(encoded).toBe(plain);
  });

  it('passes an explicit CA without retaining URL TLS overrides', () => {
    const config = secureConnectionConfig(
      'postgresql://user:secret@source.example.com:5432/sophy?sslmode=verify-full&sslrootcert=/tmp/unsafe',
      {
        label: 'Source database',
        allowInsecureTls: false,
        applicationName: 'test',
        ca: 'trusted test CA',
      },
    );

    expect(config.connectionString).not.toContain('sslrootcert');
    expect(config.ssl).toEqual({
      rejectUnauthorized: true,
      ca: 'trusted test CA',
    });
  });

  it('rejects the wrong target port without exposing credentials', () => {
    expect(() =>
      secureConnectionConfig(
        'postgresql://user:secret@target.example.com:6543/sophy?sslmode=verify-full',
        {
          label: 'Target database',
          allowInsecureTls: false,
          applicationName: 'test',
          expectedPort: 5432,
        },
      ),
    ).toThrow('Target database must use port 5432.');
  });

  it('rejects query parameters that override the checked target route', () => {
    expect(() =>
      secureConnectionConfig(
        'postgresql://user:secret@target.example.com:5432/sophy?sslmode=verify-full&host=old.example.com&port=6543',
        {
          label: 'Target database',
          allowInsecureTls: false,
          applicationName: 'test',
          expectedPort: 5432,
        },
      ),
    ).toThrow('connection override');
  });

  it('keeps the effective direct host and port', () => {
    const config = secureConnectionConfig(
      'postgresql://user:secret@target.example.com:5432/sophy?sslmode=verify-full',
      {
        label: 'Target database',
        allowInsecureTls: false,
        applicationName: 'test',
        expectedPort: 5432,
      },
    );
    const client = new pg.Client(config);
    expect(client.host).toBe('target.example.com');
    expect(client.port).toBe(5432);
  });

  it('rejects a target outside the expected provider', () => {
    expect(() =>
      secureConnectionConfig(
        'postgresql://user:secret@old.pooler.supabase.com:5432/sophy?sslmode=verify-full',
        {
          label: 'Target database',
          allowInsecureTls: false,
          applicationName: 'test',
          expectedHostSuffix: 'postgres.database.azure.com',
          expectedPort: 5432,
        },
      ),
    ).toThrow('expected provider');
  });
});
