import { hash, verifyHash } from './hash.util';

describe('hash / verifyHash (§15.1) — argon2id', () => {
  it('round-trips, uses argon2id with the pinned cost parameters, and salts every hash', async () => {
    const h = await hash('correct horse battery staple');
expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(await verifyHash(h, 'correct horse battery staple')).toBe(true);
    expect(await verifyHash(h, 'wrong')).toBe(false);
    expect(await hash('same')).not.toBe(await hash('same'));
  });
  it('never throws on malformed stored hashes or inputs — it simply does not match', async () => {
    expect(await verifyHash('not-a-hash', 'x')).toBe(false);
    expect(await verifyHash('', 'x')).toBe(false);
    expect(await verifyHash(undefined as never, 'x')).toBe(false);
    const h = await hash('abc');
    expect(await verifyHash(h, '')).toBe(false);
    expect(await verifyHash(h, 'a'.repeat(5000))).toBe(false);
  });
  it('rejects hashing an empty or oversized input', async () => {
    await expect(hash('')).rejects.toThrow(TypeError);
    await expect(hash('x'.repeat(5000))).rejects.toThrow(RangeError);
  });
});
