import { LogRedactor } from '../redaction/log-redactor';
import { buildLogEntry, type MetadataLimit } from './entry-builder';

const now = () => '2026-01-01T00:00:00.000Z';
const noLimit: MetadataLimit = {
  sizeLimitBytes: 16 * 1024,
  sizeLimitPolicy: 'truncate',
};
const redactor = () => new LogRedactor();

describe('buildLogEntry() — field presence and absence (§11)', () => {
  it('always includes timestamp, level, message', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {},
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: undefined,
      redactor: redactor(),
      limit: noLimit,
      now,
    });
    expect(e).toMatchObject({ timestamp: now(), level: 'info', message: 'hi' });
  });

  it('omits every optional field entirely when absent — never null, never "undefined"', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {},
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: undefined,
      redactor: redactor(),
      limit: noLimit,
      now,
    });
    for (const key of [
      'service',
      'environment',
      'instanceId',
      'module',
      'operation',
      'entityType',
      'entityId',
      'correlationId',
      'causationId',
      'traceId',
      'spanId',
      'userId',
      'error',
    ]) {
      expect(key in e).toBe(false);
    }
  });

  it('includes identity, static context, trace fields, and userId when all are present', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {
        module: 'posts',
        operation: 'create',
        entityType: 'Post',
        entityId: '42',
      },
      identity: {
        service: 'svc',
        environment: 'production',
        instanceId: 'i-1',
      },
      trace: {
        correlationId: 'c-1',
        causationId: 'ca-1',
        traceId: 't-1',
        spanId: 's-1',
      },
      logContext: { userId: 'u-1' },
      metadata: undefined,
      redactor: redactor(),
      limit: noLimit,
      now,
    });
    expect(e).toMatchObject({
      service: 'svc',
      environment: 'production',
      instanceId: 'i-1',
      module: 'posts',
      operation: 'create',
      entityType: 'Post',
      entityId: '42',
      correlationId: 'c-1',
      causationId: 'ca-1',
      traceId: 't-1',
      spanId: 's-1',
      userId: 'u-1',
    });
  });

  it('a defined-but-falsy trace field (e.g. an empty string, hypothetically) is still included — only undefined is omitted', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {},
      identity: {},
      trace: { correlationId: '' },
      logContext: undefined,
      metadata: undefined,
      redactor: redactor(),
      limit: noLimit,
      now,
    });
    expect(e.correlationId).toBe('');
  });

  it('merges caller metadata after named fields', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {},
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: { userAgent: 'x', custom: 42 },
      redactor: redactor(),
      limit: noLimit,
      now,
    });
    expect(e.custom).toBe(42);
  });

  it('extra static-context keys beyond the four named ones are merged in too, redacted like any other field', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: { projectId: 'proj-1', apiKey: 'sk-secret' },
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: undefined,
      redactor: redactor(),
      limit: noLimit,
      now,
    });
    expect(e.projectId).toBe('proj-1');
    expect(e.apiKey).toBe('[REDACTED]');
  });

  it('error is placed last and serialized via the error-serializer (§13 integration)', () => {
    const e = buildLogEntry({
      level: 'error',
      message: 'boom',
      staticContext: {},
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: { a: 1 },
      rawError: new Error('bad'),
      redactor: redactor(),
      limit: noLimit,
      now,
    });
    const keys = Object.keys(e);
    expect(keys[keys.length - 1]).toBe('error');
    expect(e.error?.name).toBe('Error');
    expect(e.error?.message).toBe('bad');
  });
});

describe('buildLogEntry() — field order (§11 "recommended field order")', () => {
  it('emits keys in the documented order when every field is present', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {
        module: 'm',
        operation: 'o',
        entityType: 'et',
        entityId: 'ei',
      },
      identity: { service: 's', environment: 'production', instanceId: 'inst' },
      trace: {
        correlationId: 'c',
        causationId: 'ca',
        traceId: 't',
        spanId: 'sp',
      },
      logContext: { userId: 'u' },
      metadata: { extra: 1 },
      rawError: new Error('x'),
      redactor: redactor(),
      limit: noLimit,
      now,
    });
    expect(Object.keys(e)).toEqual([
      'timestamp',
      'level',
      'message',
      'service',
      'environment',
      'instanceId',
      'module',
      'operation',
      'entityType',
      'entityId',
      'correlationId',
      'causationId',
      'traceId',
      'spanId',
      'userId',
      'extra',
      'error',
    ]);
  });
});

describe('buildLogEntry() — redaction of caller metadata (§14 integration)', () => {
  it('redacts a sensitive metadata key', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {},
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: { password: 'hunter2', username: 'bob' },
      redactor: redactor(),
      limit: noLimit,
      now,
    });
    expect(e.password).toBe('[REDACTED]');
    expect(e.username).toBe('bob');
  });
});

describe('buildLogEntry() — metadata size limit (§15)', () => {
  const bigMetadata = { blob: 'x'.repeat(1000) };

  it('passes through metadata under the limit unchanged', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {},
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: { small: 'y' },
      redactor: redactor(),
      limit: { sizeLimitBytes: 1024, sizeLimitPolicy: 'truncate' },
      now,
    });
    expect(e.small).toBe('y');
  });

  it('"truncate" policy replaces oversized metadata with an explicit marker, never silently drops it with no trace', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {},
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: bigMetadata,
      redactor: redactor(),
      limit: { sizeLimitBytes: 10, sizeLimitPolicy: 'truncate' },
      now,
    });
    expect(e.metadataTruncated).toBe(true);
    expect(e.blob).toBeUndefined();
    expect(typeof e.metadataSizeBytes).toBe('number');
  });

  it('"reject" policy replaces oversized metadata with a rejection marker instead', () => {
    const e = buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {},
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: bigMetadata,
      redactor: redactor(),
      limit: { sizeLimitBytes: 10, sizeLimitPolicy: 'reject' },
      now,
    });
    expect(e.metadataRejected).toBe(true);
    expect(e.blob).toBeUndefined();
  });

  it('calls onMetadataOversized with the entry level so it can be counted as a drop (§26)', () => {
    const onMetadataOversized = jest.fn();
    buildLogEntry({
      level: 'warn',
      message: 'hi',
      staticContext: {},
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: bigMetadata,
      redactor: redactor(),
      limit: { sizeLimitBytes: 10, sizeLimitPolicy: 'truncate' },
      now,
      onMetadataOversized,
    });
    expect(onMetadataOversized).toHaveBeenCalledWith('warn');
  });

  it('never calls onMetadataOversized when metadata is within the limit', () => {
    const onMetadataOversized = jest.fn();
    buildLogEntry({
      level: 'info',
      message: 'hi',
      staticContext: {},
      identity: {},
      trace: undefined,
      logContext: undefined,
      metadata: { small: 1 },
      redactor: redactor(),
      limit: noLimit,
      now,
      onMetadataOversized,
    });
    expect(onMetadataOversized).not.toHaveBeenCalled();
  });
});
