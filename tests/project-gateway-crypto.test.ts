import { describe, expect, it } from 'vitest';
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
  fingerprintGatewayCredential,
  GatewayCredentialCryptoError,
} from '@/lib/gateway/credential-crypto';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const FINGERPRINT_KEY = 'fingerprint-test-key-material-32-bytes-minimum';
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const CREDENTIAL_ID = '00000000-0000-4000-8000-000000000002';

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
});
