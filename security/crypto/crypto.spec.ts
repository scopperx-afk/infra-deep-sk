import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from './compare.util';
import { randomInt, randomToken } from './random.util';
import { hmacSign, hmacVerify } from './hmac.util';
import { computeFingerprint } from './fingerprint.util';
import { configureKeyRing, decodeKeyMaterial, resetKeyRing } from './key-ring';
import { decrypt, encrypt } from './encrypt.util';
import { verifySignature } from './signature.util';
import { generateIdempotencyKey, validateIdempotencyKey } from '../protocol/idempotency-key.util';

describe('constantTimeEquals (§15.6)', () => {
  it('matches equal strings/buffers and rejects different ones, of equal or different length', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals(Buffer.from('x'), 'x')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', 'a')).toBe(false);
  });
  it('never throws on a missing operand (an absent header is just "no match")', () => {
    expect(constantTimeEquals(undefined as never, 'x')).toBe(false);
    expect(constantTimeEquals('x', null as never)).toBe(false);
  });
  it('shows no timing correlation with the number of matching leading bytes', () => {
    // Statistical smoke check, deliberately loose (CI noise): compare the mean time of a
    // first-byte mismatch against a last-byte mismatch over many runs. A short-circuiting
    // compare differs by a factor; this one must stay within an order of magnitude.
    const secret = 'a'.repeat(512);
    const early = 'b' + 'a'.repeat(511);
    const late = 'a'.repeat(511) + 'b';
    const time = (candidate: string): bigint => {
      const start = process.hrtime.bigint();
      for (let i = 0; i < 3000; i++) constantTimeEquals(secret, candidate);
      return process.hrtime.bigint() - start;
    };
    time(early); time(late); // warm-up
    const e = Number(time(early));
    const l = Number(time(late));
    expect(Math.max(e, l) / Math.min(e, l)).toBeLessThan(3);
  });
});

describe('secure random (§15.5)', () => {
  it('randomToken: 32 bytes default (64 hex), unique, bounds enforced', () => {
    expect(randomToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken(16)).toHaveLength(32);
    expect(randomToken()).not.toBe(randomToken());
    expect(() => randomToken(8)).toThrow(RangeError);
    expect(() => randomToken(2048)).toThrow(RangeError);
    expect(() => randomToken(16.5)).toThrow(RangeError);
  });
  it('randomInt: [min, max) and validated', () => {
    for (let i = 0; i < 200; i++) {
      const n = randomInt(5, 8);
      expect(n >= 5 && n < 8).toBe(true);
    }
    expect(() => randomInt(5, 5)).toThrow(RangeError);
    expect(() => randomInt(1.5, 9)).toThrow(RangeError);
  });
});

describe('HMAC (§15.7)', () => {
  it('signs and verifies; rejects tampering, malformed signatures and non-strings', () => {
    const signature = hmacSign('payload', 'secret');
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacVerify('payload', signature, 'secret')).toBe(true);
    expect(hmacVerify('payload', signature.toUpperCase(), 'secret')).toBe(true);
    expect(hmacVerify('payloae', signature, 'secret')).toBe(false);
    expect(hmacVerify('payload', signature, 'other')).toBe(false);
    expect(hmacVerify('payload', 'zz', 'secret')).toBe(false);
    expect(hmacVerify('payload', undefined as never, 'secret')).toBe(false);
  });
  it('an empty secret is a programming error, never a valid key', () => {
    expect(() => hmacSign('a', '')).toThrow(TypeError);
    expect(() => hmacVerify('a', 'b', '')).toThrow(TypeError);
  });
});

describe('computeFingerprint (§15.4)', () => {
  it('is deterministic, undefined for empty input, and collision-safe across field boundaries', () => {
    expect(computeFingerprint({})).toBeUndefined();
    expect(computeFingerprint({ userAgent: '  ', deviceId: '' })).toBeUndefined();
    expect(computeFingerprint({ userAgent: 'ab', deviceId: 'c' })).toBe(computeFingerprint({ userAgent: 'ab', deviceId: 'c' }));
    expect(computeFingerprint({ userAgent: 'ab', deviceId: 'c' })).not.toBe(computeFingerprint({ userAgent: 'a', deviceId: 'bc' }));
    expect(computeFingerprint({ userAgent: 'x' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('encrypt / decrypt with key rotation (§15.2)', () => {
  const k1 = randomBytes(32).toString('hex');
  const k2 = randomBytes(32).toString('base64');
  afterEach(() => resetKeyRing());

  it('throws a clear error until a key is configured', () => {
    expect(() => encrypt('x')).toThrow('not configured');
  });

  it('round-trips and produces a fresh IV every call', () => {
    configureKeyRing({ currentKeyId: 'k1', currentKeyRef: k1 });
    const c = encrypt('secret-data');
    expect(c.startsWith('k1:')).toBe(true);
    expect(c.split(':')).toHaveLength(4);
    expect(decrypt(c)).toBe('secret-data');
    expect(encrypt('a')).not.toBe(encrypt('a'));
    expect(decrypt(encrypt(''))).toBe('');
    expect(decrypt(encrypt('héllo ✓ 日本'))).toBe('héllo ✓ 日本');
  });

  it('rotating currentKeyId does NOT break ciphertexts encrypted under a now-retired key', () => {
    configureKeyRing({ currentKeyId: 'k1', currentKeyRef: k1 });
    const old = encrypt('legacy');
    configureKeyRing({ currentKeyId: 'k2', currentKeyRef: k2, retiredKeys: [{ id: 'k1', keyRef: k1 }] });
    expect(decrypt(old)).toBe('legacy');
    expect(encrypt('new').startsWith('k2:')).toBe(true);
  });

  it('never encrypts with a retired key, and an unknown key id cannot decrypt', () => {
    configureKeyRing({ currentKeyId: 'k2', currentKeyRef: k2, retiredKeys: [{ id: 'k1', keyRef: k1 }] });
    expect(() => encrypt('x', 'k1')).toThrow('decrypt-only');
    expect(() => encrypt('x', 'k2')).not.toThrow();
    configureKeyRing({ currentKeyId: 'k2', currentKeyRef: k2 });
    const orphan = (() => { configureKeyRing({ currentKeyId: 'k1', currentKeyRef: k1 }); return encrypt('x'); })();
    configureKeyRing({ currentKeyId: 'k2', currentKeyRef: k2 });
    expect(() => decrypt(orphan)).toThrow('decryption failed');
  });

  it('rejects tampering: modified ciphertext, relabelled key id, truncated tag, garbage', () => {
    configureKeyRing({ currentKeyId: 'k1', currentKeyRef: k1, });
    const [id, iv, data, tag] = encrypt('hello').split(':') as [string, string, string, string];
    const flipped = Buffer.from(data, 'base64url'); flipped[0] = (flipped[0] as number) ^ 1;
    expect(() => decrypt([id, iv, flipped.toString('base64url'), tag].join(':'))).toThrow('decryption failed');
    expect(() => decrypt([id, iv, data, Buffer.from(tag, 'base64url').subarray(0, 8).toString('base64url')].join(':'))).toThrow('decryption failed');
    configureKeyRing({ currentKeyId: 'k1', currentKeyRef: k1, retiredKeys: [{ id: 'k0', keyRef: k1 }] }); // same key under a second id
    expect(() => decrypt(['k0', iv, data, tag].join(':'))).toThrow('decryption failed'); // key id is bound as AAD
    expect(() => decrypt('nonsense')).toThrow('decryption failed');
    expect(() => decrypt(undefined as never)).toThrow('decryption failed');
  });

  it('validates the key ring: ids together, key length, duplicates', () => {
    expect(() => configureKeyRing({ currentKeyId: 'k' })).toThrow('together');
    expect(() => configureKeyRing({ currentKeyId: 'k', currentKeyRef: 'tooshort' })).toThrow('32 bytes');
    expect(() => configureKeyRing({ currentKeyId: 'bad:id', currentKeyRef: k1 })).toThrow('invalid');
    expect(() => configureKeyRing({ currentKeyId: 'a', currentKeyRef: k1, retiredKeys: [{ id: 'a', keyRef: k2 }] })).toThrow('duplicate');
    expect(decodeKeyMaterial(k1)).toHaveLength(32);
    expect(decodeKeyMaterial(k2)).toHaveLength(32);
  });
});

describe('verifySignature (§15.3, §18.1)', () => {
  const secret = 'whsec_test_secret';
  const body = Buffer.from('{"event":"x"}');
  const nowMs = 1_800_000_000_000;
  const ts = String(nowMs / 1000);
  const sign = (t: string, b: Buffer = body, algorithm = 'sha256'): string =>
    createHmac(algorithm, secret).update(Buffer.concat([Buffer.from(`${t}.`), b])).digest('hex');
  const req = (headers: Record<string, string | string[]>, rawBody: Buffer | undefined = body) => ({ rawBody, headers });

  it('accepts an authentic, fresh payload (also with the sha256= prefix and rotated multi-signatures)', () => {
    expect(verifySignature(req({ 'x-signature': sign(ts), 'x-signature-timestamp': ts }), secret, { nowMs })).toBe(true);
    expect(verifySignature(req({ 'x-signature': `sha256=${sign(ts)}`, 'x-signature-timestamp': ts }), secret, { nowMs })).toBe(true);
    expect(verifySignature(req({ 'x-signature': `${'a'.repeat(64)}, ${sign(ts)}`, 'x-signature-timestamp': ts }), secret, { nowMs })).toBe(true);
  });
  it('a tampered payload (one byte changed) fails', () => {
    expect(verifySignature(req({ 'x-signature': sign(ts), 'x-signature-timestamp': ts }, Buffer.from('{"event":"y"}')), secret, { nowMs })).toBe(false);
  });
  it('a replayed-but-authentic payload past toleranceSeconds also fails', () => {
    const headers = { 'x-signature': sign(ts), 'x-signature-timestamp': ts };
    expect(verifySignature(req(headers), secret, { nowMs: nowMs + 299_000 })).toBe(true);
    expect(verifySignature(req(headers), secret, { nowMs: nowMs + 301_000 })).toBe(false);
    expect(verifySignature(req(headers), secret, { nowMs: nowMs - 301_000 })).toBe(false); // from the future too
    expect(verifySignature(req(headers), secret, { nowMs: nowMs + 50_000, toleranceSeconds: 10 })).toBe(false);
  });
  it('fails closed on a missing/malformed timestamp, missing rawBody, wrong secret, duplicate headers, bad options', () => {
    expect(verifySignature(req({ 'x-signature': sign(ts) }), secret, { nowMs })).toBe(false);
    expect(verifySignature(req({ 'x-signature': sign('abc'), 'x-signature-timestamp': 'abc' }), secret, { nowMs })).toBe(false);
    expect(verifySignature({ headers: { 'x-signature': sign(ts), 'x-signature-timestamp': ts } }, secret, { nowMs })).toBe(false);
    expect(verifySignature(req({ 'x-signature': sign(ts), 'x-signature-timestamp': ts }), 'other', { nowMs })).toBe(false);
    expect(verifySignature(req({ 'x-signature': sign(ts), 'x-signature-timestamp': ts }), '', { nowMs })).toBe(false);
    expect(verifySignature(req({ 'x-signature': [sign(ts), sign(ts)], 'x-signature-timestamp': ts }), secret, { nowMs })).toBe(false);
    expect(verifySignature(req({ 'x-signature': sign(ts), 'x-signature-timestamp': ts }), secret, { nowMs, toleranceSeconds: -1 })).toBe(false);
    expect(verifySignature(req({ 'x-signature': sign(ts), 'x-signature-timestamp': ts }), secret, { nowMs, algorithm: 'md5' as never })).toBe(false);
  });
  it('supports provider-specific headers, millisecond timestamps, sha1, and body-only HMAC (timestampHeader: null)', () => {
    expect(verifySignature(req({ 'x-hub': sign(ts), 'x-ts': ts }), secret, { nowMs, signatureHeader: 'X-Hub', timestampHeader: 'X-TS' })).toBe(true);
    expect(verifySignature(req({ 'x-signature': sign(String(nowMs)), 'x-signature-timestamp': String(nowMs) }), secret, { nowMs })).toBe(true);
    expect(verifySignature(req({ 'x-signature': sign(ts, body, 'sha1'), 'x-signature-timestamp': ts }), secret, { nowMs, algorithm: 'sha1' })).toBe(true);
    const bodyOnly = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifySignature(req({ 'x-signature': bodyOnly }), secret, { timestampHeader: null })).toBe(true);
  });
});

describe('Idempotency-Key shape (§18.3)', () => {
  it('accepts generated keys and rejects malformed ones', () => {
    expect(validateIdempotencyKey(generateIdempotencyKey())).toBe(true);
    expect(validateIdempotencyKey('short')).toBe(false);
    expect(validateIdempotencyKey('abcdefghijklmnop qrstuv')).toBe(false);
    expect(validateIdempotencyKey('abcdefghijklmnopqrstuv\r\nX: 1')).toBe(false);
    expect(validateIdempotencyKey('a'.repeat(300))).toBe(false);
    expect(validateIdempotencyKey(undefined as never)).toBe(false);
  });
});
