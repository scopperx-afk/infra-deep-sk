import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  TimeoutError,
  UnauthorizedError,
  ValidationError,
} from './app-error';

describe('AppError hierarchy (§4, §6)', () => {
  it('AppError is abstract — TypeScript rejects direct instantiation at compile time', () => {
    // `abstract` is compile-time only in TS (erased at runtime, so there is nothing to assert
    // about actual JS behavior here) — this line's real assertion is TS2345 firing on the next
    // one; if AppError ever stopped being abstract, tsc would report an UNUSED @ts-expect-error
    // directive here and the build would fail.
    // @ts-expect-error — AppError is abstract; direct instantiation must not type-check.
    const attempt = () => new AppError('x');
    void attempt;
  });

  it.each([
    [NotFoundError, 'domain', 'NOT_FOUND', 404, false],
    [ConflictError, 'domain', 'CONFLICT', 409, false],
    [UnauthorizedError, 'infrastructure', 'UNAUTHORIZED', 401, false],
    [ForbiddenError, 'infrastructure', 'FORBIDDEN', 403, false],
    [RateLimitedError, 'infrastructure', 'RATE_LIMITED', 429, true],
    [
      ServiceUnavailableError,
      'infrastructure',
      'SERVICE_UNAVAILABLE',
      503,
      true,
    ],
    [TimeoutError, 'infrastructure', 'TIMEOUT', 504, true],
  ] as const)(
    '%p → category=%s code=%s httpStatus=%s retryable=%s',
    (Ctor, category, code, httpStatus, retryable) => {
      const err = new Ctor('message', { extra: 1 });
      expect(err.category).toBe(category);
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(httpStatus);
      expect(err.retryable).toBe(retryable);
      expect(err.message).toBe('message');
      expect(err.details).toEqual({ extra: 1 });
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
    },
  );

  it('details is optional and omitted (undefined) when not given', () => {
    const err = new NotFoundError('not found');
    expect(err.details).toBeUndefined();
  });

  it('ValidationError requires FieldError[] details, category="validation", code fixed', () => {
    const err = new ValidationError('bad input', [
      { path: 'email', message: 'invalid' },
    ]);
    expect(err.category).toBe('validation');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.httpStatus).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual([{ path: 'email', message: 'invalid' }]);
  });

  it('503 (breaker open) and 504 (call attempted, too slow) are structurally distinct classes, both retryable', () => {
    expect(new ServiceUnavailableError('x').code).not.toBe(
      new TimeoutError('x').code,
    );
    expect(new ServiceUnavailableError('x').retryable).toBe(true);
    expect(new TimeoutError('x').retryable).toBe(true);
  });
});

describe('extending the taxonomy (§12) — a domain subclass overrides ONLY code', () => {
  class PostNotFoundError extends NotFoundError {
    override readonly code = 'POST_NOT_FOUND';
    constructor(postId: string) {
      super(`Post ${postId} not found`, { postId });
    }
  }

  it('inherits httpStatus, category, retryable unchanged; overrides only code', () => {
    const err = new PostNotFoundError('p-42');
    expect(err.code).toBe('POST_NOT_FOUND');
    expect(err.httpStatus).toBe(404);
    expect(err.category).toBe('domain');
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({ postId: 'p-42' });
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(AppError);
  });

  it("a Layer-3-style subclass of an InfrastructureError row works identically (Queue's own pattern, §12)", () => {
    class QueueUnavailableError extends ServiceUnavailableError {
      override readonly code = 'QUEUE_UNAVAILABLE';
    }
    const err = new QueueUnavailableError('queue down');
    expect(err.code).toBe('QUEUE_UNAVAILABLE');
    expect(err.httpStatus).toBe(503);
    expect(err.category).toBe('infrastructure');
    expect(err.retryable).toBe(true); // inherited, not re-declared
  });

  it('a subclass of ValidationError works the same way', () => {
    class InvalidJobPayloadError extends ValidationError {
      override readonly code = 'INVALID_JOB_PAYLOAD';
    }
    const err = new InvalidJobPayloadError('bad payload', [
      { path: 'jobId', message: 'required' },
    ]);
    expect(err.code).toBe('INVALID_JOB_PAYLOAD');
    expect(err.httpStatus).toBe(400);
    expect(err.category).toBe('validation');
  });

  it('TypeScript itself rejects overriding httpStatus/category/retryable to a different value (Anti-Pattern #8, compile-time)', () => {
    class Attempt extends NotFoundError {
      // @ts-expect-error — httpStatus is inferred as the literal 404; overriding it to 400 must not type-check.
      override readonly httpStatus = 400;
    }
    void Attempt;
  });
});
