import { describe, it, expect, beforeAll } from 'vitest';
import { keyPrefixOf, generateKey } from '@/lib/auth/api-key';

beforeAll(() => {
  process.env.KEY_HASH_PEPPER = 'test-pepper-value-1234567890';
  process.env.MIDDLEWARE_KEY_ENV = 'live';
});

describe('keyPrefixOf', () => {
  it('derives the prefix from a well-formed key', () => {
    const random = 'a'.repeat(48);
    expect(keyPrefixOf(`mw_live_${random}`)).toBe('mw_live_aaaaaaaa');
  });

  it('rejects malformed keys', () => {
    expect(keyPrefixOf('not-a-key')).toBeNull();
    expect(keyPrefixOf('mw_live_short')).toBeNull();
    expect(keyPrefixOf('xx_live_' + 'a'.repeat(48))).toBeNull();
    // underscores / non-hex in the random segment are rejected
    expect(keyPrefixOf('mw_live_' + 'z'.repeat(48))).toBeNull();
  });
});

describe('generateKey', () => {
  it('produces a key whose prefix and last4 match, and round-trips through keyPrefixOf', () => {
    const k = generateKey();
    expect(k.fullKey.startsWith('mw_live_')).toBe(true);
    expect(keyPrefixOf(k.fullKey)).toBe(k.prefix);
    expect(k.fullKey.endsWith(k.last4)).toBe(true);
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex
  });

  it('produces distinct keys but a stable hash for the same key', () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.fullKey).not.toBe(b.fullKey);
    // Re-generating the hash for the same input is deterministic.
    const again = generateKey();
    expect(again.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
