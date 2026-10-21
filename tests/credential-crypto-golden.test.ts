/**
 * Golden vectors for the project credential envelope (D1). Written before
 * credential-crypto.ts gained the Cloudflare domain; the Vercel block must pass
 * unchanged before AND after that edit, because every stored Vercel ciphertext
 * depends on the AAD literal and the envelope format staying byte-identical.
 * Values computed with node:crypto on 2026-10-20 (00-contract.md §2.3).
 */
import { createDecipheriv } from 'node:crypto';
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

const KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='; // 32 × 0x07
const FP = 'fingerprint-test-key-material-32-bytes-minimum';
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const CREDENTIAL_ID = '00000000-0000-4000-8000-000000000002';
const KEY_VERSION = 'test-v1';
const NONCE = 'AQEBAQEBAQEBAQEB'; // 12 × 0x01

const VERCEL = {
  secret: 'vercel_gateway_secret_1234',
  encryptedSecret: 'AIT71PXTs2mwoLlWEU4vQs2YZpFsyAohawU=',
  encryptionTag: '6dCabQc94hoPGdIDH9RH1w==',
  fingerprint: 'ff2e3bda320a5510607d2609fc3832f17ab16a76e6739283812e27ad83fa6162',
};
/** credential-crypto.ts:79-84, spelled out independently of the module. */
const VERCEL_AAD = Buffer.from(
  `sophy.project-gateway-credential\u0000${PROJECT_ID}\u0000${CREDENTIAL_ID}\u0000${KEY_VERSION}`,
  'utf8',
);

function independentDecrypt(
  sealed: { encryptedSecret: string; encryptionNonce: string; encryptionTag: string },
  aad: Buffer,
): string {
  const d = createDecipheriv('aes-256-gcm', Buffer.from(KEY, 'base64'), Buffer.from(sealed.encryptionNonce, 'base64'));
  d.setAAD(aad);
  d.setAuthTag(Buffer.from(sealed.encryptionTag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(sealed.encryptedSecret, 'base64')), d.final()]).toString('utf8');
}

describe('Vercel credential envelope — golden vector (must never change)', () => {
  it('the vector is authenticated by the literal Vercel AAD', () => {
    expect(independentDecrypt(
      { encryptedSecret: VERCEL.encryptedSecret, encryptionNonce: NONCE, encryptionTag: VERCEL.encryptionTag },
      VERCEL_AAD,
    )).toBe(VERCEL.secret);
  });

  it('decryptGatewayCredential opens the stored-format vector', () => {
    expect(decryptGatewayCredential({
      projectId: PROJECT_ID,
      credentialId: CREDENTIAL_ID,
      envelope: {
        encryptedSecret: VERCEL.encryptedSecret,
        encryptionNonce: NONCE,
        encryptionTag: VERCEL.encryptionTag,
        encryptionKeyVersion: KEY_VERSION,
      },
      key: KEY,
      currentKeyVersion: KEY_VERSION,
    })).toBe(VERCEL.secret);
  });

  it('fingerprints the trimmed secret with the unchanged HMAC', () => {
    expect(fingerprintGatewayCredential(`  ${VERCEL.secret}  `, FP)).toBe(VERCEL.fingerprint);
  });

  it('encrypts in the same format under the literal AAD', () => {
    const sealed = encryptGatewayCredential({
      projectId: PROJECT_ID, credentialId: CREDENTIAL_ID, secret: `  ${VERCEL.secret}  `,
      key: KEY, keyVersion: KEY_VERSION, fingerprintKey: FP,
    });
    expect(Buffer.from(sealed.encryptionNonce, 'base64')).toHaveLength(12);
    expect(Buffer.from(sealed.encryptionTag, 'base64')).toHaveLength(16);
    expect(Buffer.from(sealed.encryptedSecret, 'base64')).toHaveLength(VERCEL.secret.length); // GCM: no padding
    expect(independentDecrypt(sealed, VERCEL_AAD)).toBe(VERCEL.secret);
    expect(sealed).toMatchObject({
      encryptionKeyVersion: KEY_VERSION,
      secretFingerprint: VERCEL.fingerprint,
      secretLastFour: '1234',
    });
  });
});

const CF = {
  accountId: '0123456789abcdef0123456789abcdef',
  token: 'cf_api_token_abcdefghijklmnopqrstuvwxyz0123',
  encryptedSecret: 'FYfW1uDWs3q+v7lPL1YSUsyecpNw/lF4NFwtDRbFRMi2x37H5Gr/sG9Aew==',
  encryptionTag: '261xXrghnPWtR9fWfL4/4w==',
  fingerprint: '8e31453f32db96d49dc7f35980d7e9bad97a7e8c58a58ddd63d592ea3005de87',
};
const CF_AAD = Buffer.from(
  `sophy.project-cloudflare-credential\u0000${PROJECT_ID}\u0000${CREDENTIAL_ID}\u0000${KEY_VERSION}\u0000${CF.accountId}`,
  'utf8',
);
const cfEnvelope = { encryptedSecret: CF.encryptedSecret, encryptionNonce: NONCE, encryptionTag: CF.encryptionTag, encryptionKeyVersion: KEY_VERSION };
const vercelEnvelope = { encryptedSecret: VERCEL.encryptedSecret, encryptionNonce: NONCE, encryptionTag: VERCEL.encryptionTag, encryptionKeyVersion: KEY_VERSION };

describe('Cloudflare credential domain — golden vector', () => {
  it('the vector is authenticated by the literal Cloudflare AAD', () => {
    expect(independentDecrypt(cfEnvelope, CF_AAD)).toBe(CF.token);
  });
  it('decryptCloudflareCredential opens it', () => {
    expect(decryptCloudflareCredential({
      projectId: PROJECT_ID, credentialId: CREDENTIAL_ID, accountId: CF.accountId,
      envelope: cfEnvelope, key: KEY, currentKeyVersion: KEY_VERSION,
    })).toBe(CF.token);
  });
  it('never opens a Vercel envelope as Cloudflare, or the reverse', () => {
    expect(() => decryptCloudflareCredential({
      projectId: PROJECT_ID, credentialId: CREDENTIAL_ID, accountId: CF.accountId,
      envelope: vercelEnvelope, key: KEY, currentKeyVersion: KEY_VERSION,
    })).toThrow(GatewayCredentialCryptoError);
    expect(() => decryptGatewayCredential({
      projectId: PROJECT_ID, credentialId: CREDENTIAL_ID,
      envelope: cfEnvelope, key: KEY, currentKeyVersion: KEY_VERSION,
    })).toThrow(GatewayCredentialCryptoError);
  });
  it('binds the account id', () => {
    expect(() => decryptCloudflareCredential({
      projectId: PROJECT_ID, credentialId: CREDENTIAL_ID, accountId: 'fedcba9876543210fedcba9876543210',
      envelope: cfEnvelope, key: KEY, currentKeyVersion: KEY_VERSION,
    })).toThrow('Cloudflare credential could not be decrypted.');
  });
  it('domain-separates the fingerprint', () => {
    expect(fingerprintCloudflareCredential(`  ${CF.token}  `, FP)).toBe(CF.fingerprint);
    expect(fingerprintCloudflareCredential(CF.token, FP)).not.toBe(fingerprintGatewayCredential(CF.token, FP));
  });
  it('encrypts under the Cloudflare AAD', () => {
    const sealed = encryptCloudflareCredential({
      projectId: PROJECT_ID, credentialId: CREDENTIAL_ID, accountId: CF.accountId, apiToken: ` ${CF.token} `,
      key: KEY, keyVersion: KEY_VERSION, fingerprintKey: FP,
    });
    expect(independentDecrypt(sealed, CF_AAD)).toBe(CF.token);
    expect(sealed).toMatchObject({ encryptionKeyVersion: KEY_VERSION, secretFingerprint: CF.fingerprint, secretLastFour: '0123' });
  });
});
