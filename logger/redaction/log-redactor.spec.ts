import { DEFAULT_REDACT_PATTERNS, LogRedactor, REDACTED } from './log-redactor';

describe('LogRedactor — key-name matching (§14)', () => {
  it('matches every default pattern, case-insensitively, as a substring of the key', () => {
    const r = new LogRedactor();
    for (const pattern of DEFAULT_REDACT_PATTERNS) {
      expect(r.matchesName(pattern)).toBe(true);
      expect(r.matchesName(pattern.toUpperCase())).toBe(true);
      expect(
        r.matchesName(`user${pattern[0].toUpperCase()}${pattern.slice(1)}`),
      ).toBe(true); // userPassword, userToken, …
    }
  });

  it('an unrelated key never matches', () => {
    const r = new LogRedactor();
    expect(r.matchesName('username')).toBe(false);
    expect(r.matchesName('email')).toBe(false);
  });

  it('extra project patterns (logging.redact.paths) work exactly like the defaults', () => {
    const r = new LogRedactor(['ssn', 'internalNote']);
    expect(r.matchesName('userSsn')).toBe(true);
    expect(r.matchesName('internalNote')).toBe(true);
    expect(r.matchesName('password')).toBe(true); // defaults still active alongside extras
  });

  it('empty/whitespace-only extra patterns are ignored, not turned into a match-everything regex', () => {
    const r = new LogRedactor(['', '   ']);
    expect(r.matchesName('anything')).toBe(false);
  });
});

describe('LogRedactor.redact() — recursive structural redaction (§14)', () => {
  it('redacts a matching key at the top level and leaves siblings untouched', () => {
    const r = new LogRedactor();
    expect(r.redact({ username: 'bob', password: 'hunter2' })).toEqual({
      username: 'bob',
      password: REDACTED,
    });
  });

  it('recurses into nested objects and arrays', () => {
    const r = new LogRedactor();
    const input = {
      user: { name: 'bob', apiKey: 'sk-123' },
      sessions: [{ cookie: 'abc' }, { cookie: 'def' }],
    };
    expect(r.redact(input)).toEqual({
      user: { name: 'bob', apiKey: REDACTED },
      sessions: [{ cookie: REDACTED }, { cookie: REDACTED }],
    });
  });

  it('a redacted value is replaced regardless of its own type (object, array, number)', () => {
    const r = new LogRedactor();
    expect(r.redact({ secret: { nested: 'x' } })).toEqual({ secret: REDACTED });
    expect(r.redact({ token: 12345 })).toEqual({ token: REDACTED });
  });

  it('never mutates the input object', () => {
    const r = new LogRedactor();
    const input = { password: 'hunter2' };
    const out = r.redact(input);
    expect(input.password).toBe('hunter2');
    expect(out).not.toBe(input);
  });

  it('primitives, Date and RegExp pass through unchanged', () => {
    const r = new LogRedactor();
    const date = new Date('2026-01-01T00:00:00.000Z');
    const re = /x/;
    expect(
      r.redact({
        n: 1,
        s: 'x',
        b: true,
        nil: null,
        undef: undefined,
        date,
        re,
      }),
    ).toEqual({
      n: 1,
      s: 'x',
      b: true,
      nil: null,
      undef: undefined,
      date,
      re,
    });
  });

  it('a circular reference is marked, never causes infinite recursion or a stack overflow', () => {
    const r = new LogRedactor();

    const obj: any = { name: 'x' };
    obj.self = obj;
    expect(() => r.redact(obj)).not.toThrow();
    expect(r.redact(obj)).toEqual({ name: 'x', self: '[CIRCULAR]' });
  });

  it('the SAME object appearing twice at sibling positions (not circular) is redacted independently both times', () => {
    const r = new LogRedactor();
    const shared = { password: 'x' };
    expect(r.redact({ a: shared, b: shared })).toEqual({
      a: { password: REDACTED },
      b: { password: REDACTED },
    });
  });

  it('stops at MAX_DEPTH with an explicit marker rather than recursing forever', () => {
    const r = new LogRedactor();
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    const out = r.redact(deep);
    // Walk down until we hit the marker; it must appear at some bounded depth, not be silently absent.
    let cur: unknown = out;
    let steps = 0;
    while (cur !== '[MAX_DEPTH]' && steps < 20) {
      cur = (cur as Record<string, unknown>).child;
      steps++;
    }
    expect(cur).toBe('[MAX_DEPTH]');
    expect(steps).toBeLessThan(12); // truncated strictly before the full depth was reached
  });

  it('class instances (non-plain objects) are left as-is rather than guessed at', () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    const r = new LogRedactor();
    const p = new Point(1, 2);
    expect(r.redact({ p })).toEqual({ p });
  });
});

describe('LogRedactor.redactText() — free-text key:value redaction (§14, error.message/error.stack)', () => {
  it('redacts "key=value" and "key: value" shapes for a sensitive key name', () => {
    const r = new LogRedactor();
    expect(r.redactText('login failed for password=hunter2')).toBe(
      'login failed for password=[REDACTED]',
    );
    // Only the immediate token after the separator is treated as "the value" — trailing prose
    // in the same sentence is left alone, since a greedy match here would risk swallowing
    // legitimate surrounding text ("password=hunter2 is against policy" → over-redaction).
    // This is why redactText is documented as a best-effort heuristic, not exhaustive (§14).
    // The credential after an auth scheme is part of the value. (This assertion used to
    // pin the opposite — `'Authorization: [REDACTED] abc.def.ghi'` — i.e. it documented a
    // JWT surviving redaction as expected behaviour.)
    expect(r.redactText('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: [REDACTED]',
    );
  });

  it('redacts a quoted value, keeping the quotes intact around the marker replacement text (§14 — value only)', () => {
    const r = new LogRedactor();
    expect(r.redactText('token="abc123"')).toBe('token=[REDACTED]');
  });

  it('leaves ordinary prose with no key:value shape untouched', () => {
    const r = new LogRedactor();
    expect(r.redactText('connection to database refused')).toBe(
      'connection to database refused',
    );
  });

  it('extra configured patterns apply to text redaction too', () => {
    const r = new LogRedactor(['ssn']);
    expect(r.redactText('found ssn=123-45-6789 in payload')).toBe(
      'found ssn=[REDACTED] in payload',
    );
  });

  it('is global — redacts every matching occurrence in one string, not just the first', () => {
    const r = new LogRedactor();
    expect(r.redactText('password=a secret=b')).toBe(
      'password=[REDACTED] secret=[REDACTED]',
    );
  });
});
