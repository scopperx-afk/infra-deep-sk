/**
 * AES-256-GCM with key rotation — Security spec §15.2.
 *
 * Output: `${keyId}:${iv}:${ciphertext}:${authTag}` (iv/ciphertext/tag base64url, so the
 * `:` delimiter can never appear inside a field).
 *
 *  - `encrypt()` ALWAYS uses the current key. The optional `keyId` argument (required in
 *    the spec's signature, optional here — SPEC-ERRATA E-S3) is an ASSERTION by the
 *    caller of which key it believes is current: if it names a retired or unknown key the
 *    call throws, because retired keys are decrypt-only (§15.2).
 *  - `decrypt()` reads the key id back off the ciphertext's own prefix and looks it up in
 *    current ∪ retired — rotating `currentKeyId` forward never strands old records.
 *  - The key id is bound into the GCM auth tag as AAD, so a ciphertext cannot be
 *    re-labelled with a different key id without failing authentication.
 *  - 96-bit random IV per call (NIST SP 800-38D §8.2.2); the tag length is pinned to 16
 *    bytes on BOTH sides (a truncated-tag ciphertext is rejected, not accepted).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecurityCryptoError } from './crypto.errors';
import { getKeyRing } from './key-ring';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const toB64u = (b: Buffer): string => b.toString('base64url');
const B64U_RE = /^[A-Za-z0-9_-]*$/;

export function encrypt(value: string, keyId?: string): string {
  if (typeof value !== 'string') throw new TypeError('encrypt(): value must be a string');
  const { current } = getKeyRing();
  if (!current) {
    throw new SecurityCryptoError(
      'encryption is not configured: set security.crypto.currentKeyId and security.crypto.currentKeyRef',
    );
  }
  if (keyId !== undefined && keyId !== current.id) {
    throw new SecurityCryptoError(
      `encrypt(): "${keyId}" is not the current key ("${current.id}") — retired keys are decrypt-only`,
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, current.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(current.id, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${current.id}:${toB64u(iv)}:${toB64u(ciphertext)}:${toB64u(cipher.getAuthTag())}`;
}

/** Throws `SecurityCryptoError` on ANY failure with one fixed message — no padding/tag/key-id oracle. */
export function decrypt(ciphertext: string): string {
  const fail = (): never => {
    throw new SecurityCryptoError('decryption failed');
  };
  if (typeof ciphertext !== 'string') return fail();
  const parts = ciphertext.split(':');
  if (parts.length !== 4) return fail();
  const [keyId, ivB64, dataB64, tagB64] = parts as [string, string, string, string];
  if (!B64U_RE.test(ivB64) || !B64U_RE.test(dataB64) || !B64U_RE.test(tagB64)) return fail();

  const ring = getKeyRing();
  const key = ring.current?.id === keyId ? ring.current.key : ring.retired.get(keyId);
  if (!key) return fail();

  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return fail();

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(keyId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return fail();
  }
}
