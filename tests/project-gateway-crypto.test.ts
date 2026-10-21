import { describe, expect, it } from 'vitest';
import {
  decryptCloudflareCredential,
  decryptGatewayCredential,
  encryptCloudflareCredential,
  encryptGatewayCredential,
  fingerprintCloudflareCredential,
  fingerprintGatewayCredential,
  GatewayCredentialCryptoError,
} from '@/lib/gateway/credential-crypto';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const FINGERPRINT_KEY = 'fingerprint-test-key-material-32-bytes-minimum';
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const CREDENTIAL_ID = '00000000-0000-4000-8000-000000000002';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const OTHER_ID = '00000000-0000-4000-8000-000000000099';

function envelope() {
  return encryptGatewayCredential({
    projectId: PROJECT_ID,
    credentialId: CREDENTIAL_ID,
    secret: '  vercel_gateway_secret_1234  ',
    key: ENCRYPTION_KEY,
    keyVersion: 'test-v1',
    fingerprintKey: FINGERPRINT_KEY,
  });
}

describe('project gateway credential envelope', () => {
  it('round-trips a normalized secret without storing it in plaintext', () => {
    const encrypted = envelope();
    expect(encrypted.encryptedSecret).not.toContain('vercel_gateway_secret');
    expect(encrypted.secretLastFour).toBe('1234');
    expect(encrypted.secretFingerprint).toHaveLength(64);

    expect(
      decryptGatewayCredential({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        envelope: encrypted,
        key: ENCRYPTION_KEY,
        currentKeyVersion: 'test-v1',
      }),
    ).toBe('vercel_gateway_secret_1234');
  });

  it('binds ciphertext to the project and immutable credential row', () => {
    const encrypted = envelope();
    for (const [projectId, credentialId] of [
      ['00000000-0000-4000-8000-000000000099', CREDENTIAL_ID],
      [PROJECT_ID, '00000000-0000-4000-8000-000000000099'],
    ]) {
      expect(() =>
        decryptGatewayCredential({
          projectId,
          credentialId,
          envelope: encrypted,
          key: ENCRYPTION_KEY,
          currentKeyVersion: 'test-v1',
        }),
      ).toThrow(GatewayCredentialCryptoError);
    }
  });

  it('fails closed on a key-version mismatch or incomplete envelope', () => {
    const encrypted = envelope();
    expect(() =>
      decryptGatewayCredential({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        envelope: encrypted,
        key: ENCRYPTION_KEY,
        currentKeyVersion: 'test-v2',
      }),
    ).toThrow(/Unsupported gateway credential key version/);
    expect(() =>
      decryptGatewayCredential({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        envelope: { ...encrypted, encryptionTag: null },
        key: ENCRYPTION_KEY,
        currentKeyVersion: 'test-v1',
      }),
    ).toThrow(/incomplete/);
  });

  it('uses a deterministic, separately-keyed fingerprint', () => {
    expect(fingerprintGatewayCredential('secret', FINGERPRINT_KEY)).toBe(
      fingerprintGatewayCredential(' secret ', FINGERPRINT_KEY),
    );
    expect(fingerprintGatewayCredential('different', FINGERPRINT_KEY)).not.toBe(
      fingerprintGatewayCredential('secret', FINGERPRINT_KEY),
    );
  });

  it('rejects invalid encryption and short fingerprint keys', () => {
    expect(() =>
      encryptGatewayCredential({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        secret: 'secret',
        key: Buffer.alloc(16).toString('base64'),
        keyVersion: 'test-v1',
        fingerprintKey: FINGERPRINT_KEY,
      }),
    ).toThrow(/exactly 32 bytes/);
    expect(() => fingerprintGatewayCredential('secret', 'short')).toThrow(/at least 32 bytes/);
  });

  it('keeps the Vercel wording', () => {
    const encrypted = envelope();
    const decrypt = (overrides: Partial<Parameters<typeof decryptGatewayCredential>[0]>) => () =>
      decryptGatewayCredential({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        envelope: encrypted,
        key: ENCRYPTION_KEY,
        currentKeyVersion: 'test-v1',
        ...overrides,
      });
    expect(decrypt({ currentKeyVersion: 'test-v2' })).toThrow(
      /^Unsupported gateway credential key version: test-v1\.$/,
    );
    expect(decrypt({ envelope: { ...encrypted, encryptionTag: null } })).toThrow(
      /^Encrypted gateway credential is incomplete\.$/,
    );
    expect(decrypt({ projectId: OTHER_ID })).toThrow(/^Gateway credential could not be decrypted\.$/);
    expect(() => fingerprintGatewayCredential('   ', FINGERPRINT_KEY)).toThrow(
      /^Gateway credential must not be empty\.$/,
    );
  });
});

function cloudflareEnvelope() {
  return encryptCloudflareCredential({
    projectId: PROJECT_ID,
    credentialId: CREDENTIAL_ID,
    accountId: ACCOUNT_ID,
    apiToken: '  cf_token_1234  ',
    key: ENCRYPTION_KEY,
    keyVersion: 'test-v1',
    fingerprintKey: FINGERPRINT_KEY,
  });
}

describe('project Cloudflare credential envelope', () => {
  it('round-trips a Cloudflare token without storing it in plaintext', () => {
    const encrypted = cloudflareEnvelope();
    expect(encrypted.encryptedSecret).not.toContain('cf_token');
    expect(encrypted.secretLastFour).toBe('1234');
    expect(encrypted.secretFingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(
      decryptCloudflareCredential({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        accountId: ACCOUNT_ID,
        envelope: encrypted,
        key: ENCRYPTION_KEY,
        currentKeyVersion: 'test-v1',
      }),
    ).toBe('cf_token_1234');
  });

  it('binds a Cloudflare ciphertext to the project, row and account', () => {
    const encrypted = cloudflareEnvelope();
    for (const [projectId, credentialId, accountId] of [
      [OTHER_ID, CREDENTIAL_ID, ACCOUNT_ID],
      [PROJECT_ID, OTHER_ID, ACCOUNT_ID],
      [PROJECT_ID, CREDENTIAL_ID, 'fedcba9876543210fedcba9876543210'],
    ]) {
      const decrypt = () =>
        decryptCloudflareCredential({
          projectId,
          credentialId,
          accountId,
          envelope: encrypted,
          key: ENCRYPTION_KEY,
          currentKeyVersion: 'test-v1',
        });
      expect(decrypt).toThrow(GatewayCredentialCryptoError);
      expect(decrypt).toThrow('Cloudflare credential could not be decrypted.');
    }
  });

  it('fails closed on a Cloudflare key-version mismatch or incomplete envelope', () => {
    const encrypted = cloudflareEnvelope();
    expect(() =>
      decryptCloudflareCredential({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        accountId: ACCOUNT_ID,
        envelope: encrypted,
        key: ENCRYPTION_KEY,
        currentKeyVersion: 'test-v2',
      }),
    ).toThrow(/Unsupported Cloudflare credential key version: test-v1/);
    expect(() =>
      decryptCloudflareCredential({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        accountId: ACCOUNT_ID,
        envelope: { ...encrypted, encryptionTag: null },
        key: ENCRYPTION_KEY,
        currentKeyVersion: 'test-v1',
      }),
    ).toThrow(/Encrypted Cloudflare credential is incomplete/);
  });

  it('requires a normalised account id', () => {
    const encrypted = cloudflareEnvelope();
    for (const accountId of [
      '0123456789ABCDEF0123456789ABCDEF',
      '0123456789abcdef0123456789abcde', // 31 characters
      '../../x',
    ]) {
      expect(() =>
        encryptCloudflareCredential({
          projectId: PROJECT_ID,
          credentialId: CREDENTIAL_ID,
          accountId,
          apiToken: 'cf_token_1234',
          key: ENCRYPTION_KEY,
          keyVersion: 'test-v1',
          fingerprintKey: FINGERPRINT_KEY,
        }),
      ).toThrow('Cloudflare account id must be 32 lowercase hexadecimal characters.');
      expect(() =>
        decryptCloudflareCredential({
          projectId: PROJECT_ID,
          credentialId: CREDENTIAL_ID,
          accountId,
          envelope: encrypted,
          key: ENCRYPTION_KEY,
          currentKeyVersion: 'test-v1',
        }),
      ).toThrow('Cloudflare account id must be 32 lowercase hexadecimal characters.');
    }
  });

  it('rejects an empty Cloudflare token', () => {
    expect(() =>
      encryptCloudflareCredential({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        accountId: ACCOUNT_ID,
        apiToken: '   ',
        key: ENCRYPTION_KEY,
        keyVersion: 'test-v1',
        fingerprintKey: FINGERPRINT_KEY,
      }),
    ).toThrow('Cloudflare credential must not be empty.');
    expect(() => fingerprintCloudflareCredential('   ', FINGERPRINT_KEY)).toThrow(
      'Cloudflare credential must not be empty.',
    );
  });
});
