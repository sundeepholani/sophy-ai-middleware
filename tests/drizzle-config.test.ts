import { afterEach, describe, expect, it, vi } from 'vitest';

const originalDatabaseUrl = process.env.DATABASE_URL_UNPOOLED;

afterEach(() => {
  vi.resetModules();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL_UNPOOLED;
  } else {
    process.env.DATABASE_URL_UNPOOLED = originalDatabaseUrl;
  }
});

describe('Drizzle migration database configuration', () => {
  it('rejects duplicate sslmode values that can disable TLS', async () => {
    process.env.DATABASE_URL_UNPOOLED =
      'postgresql://sophy_migrator:secret@sophy.postgres.database.azure.com:5432/sophy?sslmode=verify-full&sslmode=disable';
    vi.resetModules();

    await expect(import('../drizzle.config')).rejects.toThrow(
      'Azure migration connections require sslmode=verify-full.',
    );
  });

  it('rejects query parameters that override the checked route', async () => {
    process.env.DATABASE_URL_UNPOOLED =
      'postgresql://sophy_migrator:secret@sophy.postgres.database.azure.com:5432/sophy?sslmode=verify-full&host=old.pooler.supabase.com&port=6543';
    vi.resetModules();

    await expect(import('../drizzle.config')).rejects.toThrow('connection override');
  });

  it('does not expose a password from a malformed URL', async () => {
    const secret = 'do-not-print-this-password';
    process.env.DATABASE_URL_UNPOOLED =
      `postgresql://sophy_migrator:${secret}@sophy.postgres.database.azure.com:invalid/sophy`;
    vi.resetModules();

    try {
      await import('../drizzle.config');
      throw new Error('Expected the malformed URL to fail.');
    } catch (error) {
      expect(String(error)).toBe(
        'Error: DATABASE_URL_UNPOOLED is invalid or contains a connection override.',
      );
      expect(String(error)).not.toContain(secret);
    }
  });
});
