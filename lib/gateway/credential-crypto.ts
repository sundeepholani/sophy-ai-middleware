/**
 * Envelope helpers for project-scoped provider credentials: Vercel AI Gateway
 * keys and Cloudflare Workers AI API tokens.
 *
 * Ciphertexts are bound to both the project and the immutable credential row
 * with AES-256-GCM additional authenticated data. Copying a ciphertext between
 * projects (or rows) therefore fails closed instead of silently changing which
 * tenant pays for a request. The independently keyed HMAC fingerprint supports
 * duplicate detection without making the secret recoverable.
 *
 * Each credential type has its own AAD domain label and fingerprint domain
 * (docs/multi-tenancy-plan.md binds the credential type): a Vercel ciphertext
 * replayed as a Cloudflare row, or the reverse, fails the GCM tag check, and one
 * secret never fingerprints the same across types. A Cloudflare ciphertext is
 * also bound to its account id.
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

const CLOUDFLARE_DOMAIN = 'sophy.project-cloudflare-credential';
/** Normalised Cloudflare account id (cloudflare-provider.ts normalises; the DB CHECK enforces). */
const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** What the GCM tag authenticates besides the plaintext. The label binds the credential TYPE (docs/multi-tenancy-plan.md). */
type CredentialAad =
  | { kind: 'vercel'; projectId: string; credentialId: string; keyVersion: string }
  | { kind: 'cloudflare'; projectId: string; credentialId: string; keyVersion: string; accountId: string };

function associatedData(aad: CredentialAad): Buffer {
  if (aad.kind === 'vercel') {
    // BYTE-IDENTICAL to the pre-Cloudflare literal: every stored Vercel ciphertext
    // depends on it. Pinned by tests/credential-crypto-golden.test.ts — never edit.
    return Buffer.from(
      `sophy.project-gateway-credential\0${aad.projectId}\0${aad.credentialId}\0${aad.keyVersion}`,
      'utf8',
    );
  }
  return Buffer.from(
    `${CLOUDFLARE_DOMAIN}\0${aad.projectId}\0${aad.credentialId}\0${aad.keyVersion}\0${aad.accountId}`,
    'utf8',
  );
}

/** Error wording per credential type. The Vercel strings are the existing ones, verbatim. */
interface CredentialNoun {
  empty: string;
  incomplete: string;
  badVersion: (version: string) => string;
  undecryptable: string;
}
const VERCEL_NOUN: CredentialNoun = {
  empty: 'Gateway credential must not be empty.',
  incomplete: 'Encrypted gateway credential is incomplete.',
  badVersion: (v) => `Unsupported gateway credential key version: ${v}.`,
  undecryptable: 'Gateway credential could not be decrypted.',
};
const CLOUDFLARE_NOUN: CredentialNoun = {
  empty: 'Cloudflare credential must not be empty.',
  incomplete: 'Encrypted Cloudflare credential is incomplete.',
  badVersion: (v) => `Unsupported Cloudflare credential key version: ${v}.`,
  undecryptable: 'Cloudflare credential could not be decrypted.',
};

function nonEmpty(secret: string, noun: CredentialNoun): string {
  const normalized = secret.trim();
  if (!normalized) throw new GatewayCredentialCryptoError(noun.empty);
  return normalized;
}

function nonEmptySecret(secret: string): string {
  return nonEmpty(secret, VERCEL_NOUN);
}

type SealedSecret = Pick<GatewayCredentialEnvelope, 'encryptedSecret' | 'encryptionNonce' | 'encryptionTag'>;

/** AES-256-GCM with a fresh 96-bit nonce. Same bytes/encoding as before the refactor. */
function seal(aad: CredentialAad, plaintext: string, key?: string): SealedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(key), nonce);
  cipher.setAAD(associatedData(aad));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    encryptedSecret: encrypted.toString('base64'),
    encryptionNonce: nonce.toString('base64'),
    encryptionTag: cipher.getAuthTag().toString('base64'),
  };
}

/** Fails closed on missing fields, key-version mismatch, tampering, or any AAD substitution. */
function open(input: {
  envelope: StoredGatewayCredentialEnvelope;
  key?: string;
  currentKeyVersion?: string;
  aad: (keyVersion: string) => CredentialAad;
  noun: CredentialNoun;
}): string {
  const { encryptedSecret, encryptionNonce, encryptionTag, encryptionKeyVersion } = input.envelope;
  if (!encryptedSecret || !encryptionNonce || !encryptionTag || !encryptionKeyVersion) {
    throw new GatewayCredentialCryptoError(input.noun.incomplete);
  }

  const currentKeyVersion =
    input.currentKeyVersion?.trim() || env.projectGatewayEncryptionKeyVersion();
  if (encryptionKeyVersion !== currentKeyVersion) {
    throw new GatewayCredentialCryptoError(input.noun.badVersion(encryptionKeyVersion));
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(input.key),
      Buffer.from(encryptionNonce, 'base64'),
    );
    decipher.setAAD(associatedData(input.aad(encryptionKeyVersion)));
    decipher.setAuthTag(Buffer.from(encryptionTag, 'base64'));
    return nonEmpty(
      Buffer.concat([
        decipher.update(Buffer.from(encryptedSecret, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
      input.noun,
    );
  } catch (cause) {
    if (cause instanceof GatewayCredentialCryptoError) throw cause;
    throw new GatewayCredentialCryptoError(input.noun.undecryptable, cause);
  }
}

// ---- Vercel AI Gateway (unchanged contract) ----------------------------------

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
  const sealed = seal(
    { kind: 'vercel', projectId: input.projectId, credentialId: input.credentialId, keyVersion },
    secret,
    input.key,
  );

  return {
    ...sealed,
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
  return open({
    envelope: input.envelope,
    key: input.key,
    currentKeyVersion: input.currentKeyVersion,
    noun: VERCEL_NOUN,
    aad: (keyVersion) => ({
      kind: 'vercel',
      projectId: input.projectId,
      credentialId: input.credentialId,
      keyVersion,
    }),
  });
}

// ---- Cloudflare Workers AI (D1) ----------------------------------------------

function cloudflareAccountId(accountId: string): string {
  if (typeof accountId !== 'string' || !CLOUDFLARE_ACCOUNT_ID.test(accountId)) {
    throw new GatewayCredentialCryptoError(
      'Cloudflare account id must be 32 lowercase hexadecimal characters.',
    );
  }
  return accountId;
}

/**
 * HMAC-SHA256(fingerprint key, 'sophy.project-cloudflare-credential\0' + trimmed token), hex.
 * Domain-separated from the Vercel fingerprint, so one secret never collides across types.
 */
export function fingerprintCloudflareCredential(apiToken: string, key?: string): string {
  return createHmac('sha256', fingerprintKey(key))
    .update(`${CLOUDFLARE_DOMAIN}\0${nonEmpty(apiToken, CLOUDFLARE_NOUN)}`, 'utf8')
    .digest('hex');
}

/** Same envelope shape as Vercel. The AAD also binds the (normalised) account id. */
export function encryptCloudflareCredential(input: {
  projectId: string;
  credentialId: string;
  accountId: string;
  apiToken: string;
  key?: string;
  keyVersion?: string;
  fingerprintKey?: string;
}): GatewayCredentialEnvelope {
  const apiToken = nonEmpty(input.apiToken, CLOUDFLARE_NOUN);
  const accountId = cloudflareAccountId(input.accountId);
  const keyVersion = input.keyVersion?.trim() || env.projectGatewayEncryptionKeyVersion();
  const sealed = seal(
    {
      kind: 'cloudflare',
      projectId: input.projectId,
      credentialId: input.credentialId,
      keyVersion,
      accountId,
    },
    apiToken,
    input.key,
  );

  return {
    ...sealed,
    encryptionKeyVersion: keyVersion,
    secretFingerprint: fingerprintCloudflareCredential(apiToken, input.fingerprintKey),
    secretLastFour: apiToken.slice(-4),
  };
}

/**
 * Decrypt a stored Cloudflare token. Fails closed exactly like
 * decryptGatewayCredential, plus account substitution.
 */
export function decryptCloudflareCredential(input: {
  projectId: string;
  credentialId: string;
  accountId: string;
  envelope: StoredGatewayCredentialEnvelope;
  key?: string;
  currentKeyVersion?: string;
}): string {
  const accountId = cloudflareAccountId(input.accountId);
  return open({
    envelope: input.envelope,
    key: input.key,
    currentKeyVersion: input.currentKeyVersion,
    noun: CLOUDFLARE_NOUN,
    aad: (keyVersion) => ({
      kind: 'cloudflare',
      projectId: input.projectId,
      credentialId: input.credentialId,
      keyVersion,
      accountId,
    }),
  });
}
