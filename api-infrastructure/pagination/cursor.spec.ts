/** Cursor codec — spec §5.1.3, §13 ("decodeCursor returns null on the four distinct failure modes"), plus E-A13 hardening. */
import { MAX_CURSOR_LENGTH } from '../api-infrastructure.constants';
import { withApiRuntime } from '../testing/with-api-runtime';
import { decodeCursor, encodeCursor } from './cursor';

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(40);
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

describe('cursor codec — unsigned (the §5.1.3 default)', () => {
  it('round-trips an arbitrary JSON-safe payload exactly', () => {
    const payload = { id: 'u-123', createdAt: '2026-01-01T00:00:00.000Z', n: 5, nested: { a: [1, 2, 3] }, flag: false, nil: null };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it('produces a URL-safe token (no +, /, = or .)', () => {
    const token = encodeCursor({ q: '???>>>~~~ÿ' });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  describe('decodeCursor returns null — never throws — on malformed input', () => {
    it.each([
      ['empty string', ''],
      ['not base64url (illegal characters)', '!!!not base64!!!'],
      ['valid base64url but not JSON', b64('this is not json')],
      ['valid JSON but not an object (number)', b64('42')],
      ['valid JSON but not an object (array)', b64('[1,2,3]')],
      ['valid JSON but not an object (null)', b64('null')],
      ['valid JSON but not an object (string)', b64('"hello"')],
    ])('%s', (_label, input) => {
      expect(() => decodeCursor(input)).not.toThrow();
      expect(decodeCursor(input)).toBeNull();
    });

    it.each([undefined, null, 42, {}, [], true])('a non-string argument (%p)', (bad) => {
      expect(decodeCursor(bad as unknown as string)).toBeNull();
    });
  });

  it('rejects a cursor longer than MAX_CURSOR_LENGTH before doing any decoding work', () => {
    const huge = 'A'.repeat(MAX_CURSOR_LENGTH + 1);
    expect(decodeCursor(huge)).toBeNull();
  });

  it('is STRICT about the alphabet: Buffer.from() would silently skip these characters, aliasing many strings to one cursor', () => {
    const good = encodeCursor({ id: 1 });
    expect(decodeCursor(good + '=')).toBeNull(); // padding
    expect(decodeCursor(good.slice(0, 4) + ' ' + good.slice(4))).toBeNull(); // whitespace inside
    expect(decodeCursor('\n' + good)).toBeNull();
  });

  describe('prototype-pollution hardening', () => {
    it.each([
      ['top-level __proto__', '{"__proto__":{"polluted":true},"id":1}'],
      ['nested __proto__', '{"a":{"b":{"__proto__":{"x":1}}}}'],
      ['constructor key', '{"constructor":{"prototype":{"x":1}}}'],
      ['prototype key', '{"prototype":{"x":1}}'],
      ['__proto__ inside an array element', '{"list":[{"__proto__":{"x":1}}]}'],
    ])('%s is rejected outright (not silently stripped)', (_label, json) => {
      expect(decodeCursor(b64(json))).toBeNull();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('a legitimate key that merely CONTAINS those words is fine', () => {
      expect(decodeCursor(b64('{"constructorId":1,"protoType":2}'))).toEqual({ constructorId: 1, protoType: 2 });
    });
  });

  describe('encodeCursor — the one function that may throw, on programmer error', () => {
    it.each([[null], [[1, 2]], ['str'], [42], [undefined]])('refuses a non-object payload (%p)', (bad) => {
      expect(() => encodeCursor(bad as unknown as Record<string, unknown>)).toThrow(TypeError);
    });

    it('refuses a payload whose encoding exceeds MAX_CURSOR_LENGTH — a cursor the decoder would later reject is worse than a loud failure', () => {
      expect(() => encodeCursor({ blob: 'x'.repeat(MAX_CURSOR_LENGTH) })).toThrow(RangeError);
    });

    it('serialises a Date as its ISO string (documented — the domain parses it back)', () => {
      const d = new Date('2026-05-05T05:05:05.000Z');
      expect(decodeCursor(encodeCursor({ at: d }))).toEqual({ at: '2026-05-05T05:05:05.000Z' });
    });
  });
});

describe('cursor codec — signed (api.cursor.signingKeys configured, E-A13)', () => {
  const signed = <T>(fn: () => T, keys: string[] = [KEY_A]): T =>
    withApiRuntime({ cursorSigningKeys: keys }, fn);

  it('round-trips, and the token is `body.signature`', () => {
    signed(() => {
      const token = encodeCursor({ id: 'u-1' });
      expect(token.split('.')).toHaveLength(2);
      expect(decodeCursor(token)).toEqual({ id: 'u-1' });
    });
  });

  it('a payload edited by the client fails verification (the whole point)', () => {
    signed(() => {
      const [, sig] = encodeCursor({ id: 'u-1' }).split('.');
      const forged = `${b64('{"id":"u-999"}')}.${sig}`;
      expect(decodeCursor(forged)).toBeNull();
    });
  });

  it('a flipped signature byte fails verification', () => {
    signed(() => {
      const [body, sig] = encodeCursor({ id: 'u-1' }).split('.') as [string, string];
      const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
      expect(decodeCursor(`${body}.${flipped}`)).toBeNull();
    });
  });

  it('an UNSIGNED cursor is rejected once signing is on (no downgrade)', () => {
    const unsigned = encodeCursor({ id: 'u-1' });
    signed(() => expect(decodeCursor(unsigned)).toBeNull());
  });

  it('a SIGNED cursor is rejected when signing is off (no guessing)', () => {
    const token = signed(() => encodeCursor({ id: 'u-1' }));
    expect(decodeCursor(token)).toBeNull();
  });

  it.each(['', '.', 'abc.', '.abc', 'a.b.c', 'x.' + 'A'.repeat(200)])('malformed signature shape %p is null, never a throw', (suffix) => {
    signed(() => {
      const body = b64('{"id":1}');
      const token = suffix.startsWith('.') || suffix === '' || suffix.includes('.') ? body + suffix : body + '.' + suffix;
      expect(() => decodeCursor(token)).not.toThrow();
      expect(decodeCursor(token)).toBeNull();
    });
  });

  describe('key rotation — the first key signs, EVERY key verifies', () => {
    it('a cursor minted under the old key still verifies after a new key is prepended', () => {
      const oldToken = signed(() => encodeCursor({ id: 'old' }), [KEY_A]);
      signed(() => expect(decodeCursor(oldToken)).toEqual({ id: 'old' }), [KEY_B, KEY_A]);
    });

    it('new cursors are minted under the NEW key (old key alone cannot verify them)', () => {
      const newToken = signed(() => encodeCursor({ id: 'new' }), [KEY_B, KEY_A]);
      signed(() => expect(decodeCursor(newToken)).toBeNull(), [KEY_A]);
      signed(() => expect(decodeCursor(newToken)).toEqual({ id: 'new' }), [KEY_B]);
    });

    it('once the old key is retired, its cursors stop verifying', () => {
      const oldToken = signed(() => encodeCursor({ id: 'old' }), [KEY_A]);
      signed(() => expect(decodeCursor(oldToken)).toBeNull(), [KEY_B]);
    });
  });

  it('the length cap applies to the SIGNED token (body + signature)', () => {
    signed(() => {
      expect(() => encodeCursor({ blob: 'x'.repeat(MAX_CURSOR_LENGTH - 40) })).toThrow(RangeError);
    });
  });
});
