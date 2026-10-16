import { LogRedactor } from '../redaction/log-redactor';
import { MAX_DEPTH } from '../logger.constants';
import { serializeError } from './error-serializer';

describe('serializeError() — basic shape (§13)', () => {
  it('serializes name, message and stack', () => {
    const err = new Error('boom');
    const out = serializeError(err);
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
    expect(out.stack).toContain('Error: boom');
  });

  it('preserves a subclass name when the subclass sets it explicitly (the standard pattern)', () => {
    class DatabaseError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'DatabaseError';
      }
    }
    const out = serializeError(new DatabaseError('conn refused'));
    expect(out.name).toBe('DatabaseError');
  });

  it('a bare subclass with NO explicit name override serializes as "Error" — real JS behavior, not a bug: `.name` is inherited from Error.prototype unless a subclass sets it itself', () => {
    class UnnamedError extends Error {}
    expect(serializeError(new UnnamedError('x')).name).toBe('Error');
  });

  it('preserves extra enumerable own properties without touching name/message/stack/cause', () => {
    class HttpError extends Error {
      statusCode = 503;
      constructor(message: string) {
        super(message);
        this.name = 'HttpError';
      }
    }
    const out = serializeError(new HttpError('unavailable')) as unknown as {
      statusCode: number;
    };
    expect(out.statusCode).toBe(503);
  });

  it('omits stack when the error genuinely has none', () => {
    const err = new Error('x');
    delete (err as { stack?: string }).stack;
    expect(serializeError(err).stack).toBeUndefined();
  });
});

describe('serializeError() — non-Error values (§13)', () => {
  it.each([
    ['a thrown string', 'plain string', 'plain string'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['a number', 42, '42'],
  ])('handles %s without throwing', (_label, value, expectedMessage) => {
    const out = serializeError(value);
    expect(out.name).toBe('NonError');
    expect(out.message).toBe(expectedMessage);
  });

  it('handles a plain object thrown as an error', () => {
    const out = serializeError({ code: 'E_WEIRD' });
    expect(out.name).toBe('NonError');
    expect(out.message).toContain('object');
  });
});

describe('serializeError() — bounded cause chain (§13)', () => {
  function chainOfLength(n: number): Error {
    let err = new Error('root cause');
    for (let i = 1; i < n; i++) {
      const next = new Error(`level ${i}`);
      (next as { cause?: unknown }).cause = err;
      err = next;
    }
    return err;
  }

  it('walks a short chain fully, with no truncation marker', () => {
    const err = chainOfLength(3);
    const out = serializeError(err);
    expect(out.message).toBe('level 2');
    expect(out.cause?.message).toBe('level 1');
    expect(out.cause?.cause?.message).toBe('root cause');
    expect(out.cause?.cause?.cause).toBeUndefined();
    expect(out.causeTruncated).toBeUndefined();
  });

  it(`walks up to exactly MAX_DEPTH (${MAX_DEPTH}) nodes, then marks the last one causeTruncated`, () => {
    const err = chainOfLength(MAX_DEPTH + 5); // deliberately deeper than the bound
    const out = serializeError(err);

    let node = out;
    let count = 1;
    while (node.cause) {
      node = node.cause;
      count++;
    }
    expect(count).toBe(MAX_DEPTH); // exactly 8 nodes walked, not 7 and not 9
    expect(node.causeTruncated).toBe(true);
    expect(node.cause).toBeUndefined(); // no synthetic placeholder node beyond the marker
  });

  it('a chain of exactly MAX_DEPTH nodes is walked in full with NO truncation marker (boundary, not off-by-one)', () => {
    const err = chainOfLength(MAX_DEPTH);
    const out = serializeError(err);
    let node = out;
    let count = 1;
    while (node.cause) {
      node = node.cause;
      count++;
    }
    expect(count).toBe(MAX_DEPTH);
    expect(node.causeTruncated).toBeUndefined();
  });

  it('a non-Error cause at the end of the chain is still serialized as a NonError leaf', () => {
    const err = new Error('top');
    (err as { cause?: unknown }).cause = 'a plain string cause';
    const out = serializeError(err);
    expect(out.cause).toEqual({
      name: 'NonError',
      message: 'a plain string cause',
    });
  });
});

describe('serializeError() — redaction integration (§13, §14)', () => {
  it('redacts a sensitive value embedded in the message text', () => {
    const redactor = new LogRedactor();
    const err = new Error('login failed for password=hunter2');
    expect(serializeError(err, redactor).message).toBe(
      'login failed for password=[REDACTED]',
    );
  });

  it('redacts a sensitive value embedded in the stack text too', () => {
    const redactor = new LogRedactor();
    const err = new Error('x');
    err.stack = 'Error: x\n    token=abc123 at somewhere';
    expect(serializeError(err, redactor).stack).toContain('token=[REDACTED]');
  });

  it('redacts a sensitive EXTRA property by key name', () => {
    class QueryError extends Error {
      password = 'hunter2';
    }
    const redactor = new LogRedactor();
    const out = serializeError(
      new QueryError('bad query'),
      redactor,
    ) as unknown as { password: string };
    expect(out.password).toBe('[REDACTED]');
  });

  it('redacts through the whole cause chain, not just the top error', () => {
    const redactor = new LogRedactor();
    const inner = new Error('token=deep-secret');
    const outer = new Error('wrapper');
    (outer as { cause?: unknown }).cause = inner;
    const out = serializeError(outer, redactor);
    expect(out.cause?.message).toBe('token=[REDACTED]');
  });

  it('without a redactor, nothing is redacted (caller opts in explicitly)', () => {
    const err = new Error('password=hunter2');
    expect(serializeError(err).message).toBe('password=hunter2');
  });
});
