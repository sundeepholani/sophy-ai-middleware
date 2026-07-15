/**
 * Envelope helpers for project-scoped Vercel AI Gateway credentials.
 *
 * Ciphertexts are bound to both the project and the immutable credential row
 * with AES-256-GCM additional authenticated data. Copying a ciphertext between
 * projects (or rows) therefore fails closed instead of silently changing which
 * tenant pays for a request. The independently keyed HMAC fingerprint supports
 * duplicate detection without making the secret recoverable.
 */
import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { env } from '@/lib/env';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const ENCRYPTION_KEY_BYTES = 32;
const MIN_FINGERPRINT_KEY_BYTES = 32;

export interface GatewayCredentialEnvelope {
  encryptedSecret: string;
  encryptionNonce: string;
  encryptionTag: string;
  encryptionKeyVersion: string;
  secretFingerprint: string;
  secretLastFour: string;
}

export interface StoredGatewayCredentialEnvelope {
  encryptedSecret: string | null;
  encryptionNonce: string | null;
  encryptionTag: string | null;
  encryptionKeyVersion: string | null;
}

export class GatewayCredentialCryptoError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'GatewayCredentialCryptoError';
  }
}

function encryptionKey(raw = env.projectGatewayEncryptionKey()): Buffer {
  const value = raw.trim();
  let decoded: Buffer;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    decoded = Buffer.from(value, 'hex');
  } else {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
      throw new GatewayCredentialCryptoError(
        'PROJECT_GATEWAY_ENCRYPTION_KEY must be 32-byte base64 or 64-character hex.',
      );
    }
    decoded = Buffer.from(value, 'base64');
  }
  if (decoded.length !== ENCRYPTION_KEY_BYTES) {
    throw new GatewayCredentialCryptoError(
      'PROJECT_GATEWAY_ENCRYPTION_KEY must decode to exactly 32 bytes.',
    );
  }
  return decoded;
}

function fingerprintKey(raw = env.projectGatewayFingerprintKey()): Buffer {
  const decoded = Buffer.from(raw, 'utf8');
  if (decoded.length < MIN_FINGERPRINT_KEY_BYTES) {
    throw new GatewayCredentialCryptoError(
      'PROJECT_GATEWAY_FINGERPRINT_KEY must contain at least 32 bytes.',
    );
  }
  return decoded;
}

function associatedData(projectId: string, credentialId: string, keyVersion: string): Buffer {
  return Buffer.from(
    `sophy.project-gateway-credential\0${projectId}\0${credentialId}\0${keyVersion}`,
    'utf8',
  );
}

function nonEmptySecret(secret: string): string {
  const normalized = secret.trim();
  if (!normalized) throw new GatewayCredentialCryptoError('Gateway credential must not be empty.');
  return normalized;
}

/** Stable, non-reversible duplicate-detection value for a gateway credential. */
export function fingerprintGatewayCredential(secret: string, key?: string): string {
  return createHmac('sha256', fingerprintKey(key))
    .update(nonEmptySecret(secret), 'utf8')
    .digest('hex');
}

/** Encrypt a newly-created immutable credential row before inserting it. */
export function encryptGatewayCredential(input: {
  projectId: string;
  credentialId: string;
  secret: string;
  key?: string;
  keyVersion?: string;
  fingerprintKey?: string;
}): GatewayCredentialEnvelope {
  const secret = nonEmptySecret(input.secret);
  const keyVersion = input.keyVersion?.trim() || env.projectGatewayEncryptionKeyVersion();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(input.key), nonce);
  cipher.setAAD(associatedData(input.projectId, input.credentialId, keyVersion));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encryptedSecret: encrypted.toString('base64'),
    encryptionNonce: nonce.toString('base64'),
    encryptionTag: tag.toString('base64'),
    encryptionKeyVersion: keyVersion,
    secretFingerprint: fingerprintGatewayCredential(secret, input.fingerprintKey),
    secretLastFour: secret.slice(-4),
  };
}

/**
 * Decrypt a stored credential, failing closed on missing fields, key-version
 * mismatch, tampering, or tenant/row substitution.
 */
export function decryptGatewayCredential(input: {
  projectId: string;
  credentialId: string;
  envelope: StoredGatewayCredentialEnvelope;
  key?: string;
  currentKeyVersion?: string;
}): string {
  const { encryptedSecret, encryptionNonce, encryptionTag, encryptionKeyVersion } = input.envelope;
  if (!encryptedSecret || !encryptionNonce || !encryptionTag || !encryptionKeyVersion) {
    throw new GatewayCredentialCryptoError('Encrypted gateway credential is incomplete.');
  }

  const currentKeyVersion =
    input.currentKeyVersion?.trim() || env.projectGatewayEncryptionKeyVersion();
  if (encryptionKeyVersion !== currentKeyVersion) {
    throw new GatewayCredentialCryptoError(
      `Unsupported gateway credential key version: ${encryptionKeyVersion}.`,
    );
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(input.key),
      Buffer.from(encryptionNonce, 'base64'),
    );
    decipher.setAAD(
      associatedData(input.projectId, input.credentialId, encryptionKeyVersion),
    );
    decipher.setAuthTag(Buffer.from(encryptionTag, 'base64'));
    return nonEmptySecret(
      Buffer.concat([
        decipher.update(Buffer.from(encryptedSecret, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    );
  } catch (cause) {
    if (cause instanceof GatewayCredentialCryptoError) throw cause;
    throw new GatewayCredentialCryptoError('Gateway credential could not be decrypted.', cause);
  }
}
