/**
 * Internal crypto failure. Deliberately NOT an HTTP exception: an unconfigured key ring
 * or an undecryptable record is a server-side fault (→ Errors maps an unknown `Error` to
 * 500), and its message never contains key material, plaintext or ciphertext.
 */
export class SecurityCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityCryptoError';
  }
}
