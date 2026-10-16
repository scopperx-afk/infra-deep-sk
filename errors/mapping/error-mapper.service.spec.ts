import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z, ZodError } from 'zod';
import {
  CONFIG_SERVICE,
  ConfigModule,
  staticSource,
  type ConfigService,
} from '../../config';
import { withTraceContext } from '../../tracing';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../domain/app-error';
import { ErrorMapperService } from './error-mapper.service';

const BASE_ENV = {
  NODE_ENV: 'test',
  APP__NAME: 'test-app',
  APP__FRONTEND_URL: 'http://x',
};

async function buildMapper(
  env: Record<string, string> = {},
): Promise<{ mapper: ErrorMapperService; config: ConfigService }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        sources: [staticSource({ ...BASE_ENV, ...env })],
        exitOnValidationFailure: false,
        onNotice: () => undefined,
      }),
    ],
    providers: [ErrorMapperService],
  }).compile();
  return {
    mapper: moduleRef.get(ErrorMapperService),
    config: moduleRef.get(CONFIG_SERVICE),
  };
}

describe('ErrorMapperService — case 1: AppError (§7)', () => {
  it("uses the error's own code/httpStatus/category/message, and includes details when present", async () => {
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(
      new NotFoundError('Post not found', { postId: 'p-1' }),
    );
    expect(result).toEqual({
      status: 404,
      category: 'domain',
      body: {
        code: 'NOT_FOUND',
        message: 'Post not found',
        details: { postId: 'p-1' },
      },
    });
  });

  it('omits details entirely when the AppError has none', async () => {
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(
      new ConflictError('already exists'),
    );
    expect('details' in result.body).toBe(false);
  });

  it('populates traceId from the active trace context, omits it when none is active', async () => {
    const { mapper } = await buildMapper();
    const withCtx = withTraceContext(
      { correlationId: 'c-1', traceId: 't-1' },
      () => mapper.mapToErrorResponse(new NotFoundError('x')),
    );
    expect(withCtx.body.traceId).toBe('t-1');

    const without = mapper.mapToErrorResponse(new NotFoundError('x'));
    expect('traceId' in without.body).toBe(false);
  });

  it('a domain subclass (§12) is still recognized as case 1, using its own overridden code', async () => {
    class PostNotFoundError extends NotFoundError {
      override readonly code = 'POST_NOT_FOUND';
    }
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(new PostNotFoundError('nope'));
    expect(result.body.code).toBe('POST_NOT_FOUND');
    expect(result.status).toBe(404);
    expect(result.category).toBe('domain');
  });
});

describe("ErrorMapperService — case 2: Nest's HttpException tree (§7 point 2)", () => {
  it('maps a known status via the fallback table (404 → NOT_FOUND/domain)', async () => {
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(new NotFoundException('missing'));
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('NOT_FOUND');
    expect(result.category).toBe('domain');
  });

  it('handles a plain-string getResponse() shape', async () => {
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(
      new HttpException('just a string', 400),
    );
    expect(result.body.message).toBe('just a string');
  });

  it("handles Nest's default {statusCode,message,error} object shape", async () => {
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(
      new NotFoundException('resource missing'),
    );
    expect(result.body.message).toBe('resource missing');
  });

  it("joins an array-of-messages shape (e.g. BadRequestException's validation array) into one string", async () => {
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(
      new BadRequestException(['field a is required', 'field b is invalid']),
    );
    expect(result.body.message).toBe('field a is required; field b is invalid');
    expect(result.body.code).toBe('VALIDATION_ERROR');
    expect(result.category).toBe('validation');
  });

  it('an uncommon SERVER status falls back to INTERNAL_ERROR/infrastructure, not "unknown" (§19\'s own distinction)', async () => {
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(new HttpException('weird', 599));
    expect(result.status).toBe(599);
    expect(result.body.code).toBe('INTERNAL_ERROR');
    expect(result.category).toBe('infrastructure'); // NOT 'unknown' — see SPEC-ERRATA.md E-E2
  });

  it('an uncommon CLIENT status is CLIENT_ERROR/validation — never INTERNAL_ERROR (a user mistake is not a server fault)', async () => {
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(new HttpException('teapot', 418));
    expect(result.status).toBe(418);
    expect(result.body.code).toBe('CLIENT_ERROR');
    expect(result.category).toBe('validation');
  });

  it('never adds a details field for an HttpException (only AppError/ZodError/dev-mode-Unknown do)', async () => {
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(new NotFoundException('x'));
    expect('details' in result.body).toBe(false);
  });
});

describe('ErrorMapperService — case 3: a raw ZodError (§7 point 3)', () => {
  const schema = z.object({
    email: z.string().email(),
    tags: z.array(z.object({ name: z.string() })),
  });

  it('always 400/VALIDATION_ERROR, message fixed to "Validation failed"', async () => {
    const { mapper } = await buildMapper();
    const parsed = schema.safeParse({
      email: 'not-an-email',
      tags: [{ name: 1 }],
    });
    const result = mapper.mapToErrorResponse(
      parsed.success ? undefined : parsed.error,
    );
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('VALIDATION_ERROR');
    expect(result.body.message).toBe('Validation failed');
    expect(result.category).toBe('validation');
  });

  it('flattens issues into FieldError[] with dotted, bracket-free paths', async () => {
    const { mapper } = await buildMapper();
    const parsed = schema.safeParse({ email: 'bad', tags: [{ name: 1 }] });
    const result = mapper.mapToErrorResponse(
      parsed.success ? undefined : parsed.error,
    );
    const details = result.body.details as Array<{
      path: string;
      message: string;
    }>;
    expect(details.find((d) => d.path === 'email')).toBeTruthy();
    expect(details.find((d) => d.path === 'tags.0.name')).toBeTruthy(); // numeric index as a plain segment
  });

  it('a root-level issue (empty path) becomes an empty-string path, not "undefined" or a throw', async () => {
    const { mapper } = await buildMapper();
    const rootSchema = z.string().email();
    const parsed = rootSchema.safeParse(123);
    const err = parsed.success ? undefined : parsed.error;
    const result = mapper.mapToErrorResponse(err);
    const details = result.body.details as Array<{
      path: string;
      message: string;
    }>;
    expect(details[0].path).toBe('');
  });

  it('is recognized even when constructed directly (not just via safeParse)', async () => {
    const { mapper } = await buildMapper();
    const err = new ZodError([{ code: 'custom', path: ['x'], message: 'bad' }]);
    const result = mapper.mapToErrorResponse(err);
    expect(result.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('ErrorMapperService — case 4: Unknown (§7 point 4, §10)', () => {
  it('always 500/INTERNAL_ERROR with a FIXED message — never the raw exception message (prevents accidental leakage)', async () => {
    const { mapper } = await buildMapper();
    const result = mapper.mapToErrorResponse(
      new Error('column "ssn" does not exist in table users'),
    );
    expect(result.status).toBe(500);
    expect(result.body.code).toBe('INTERNAL_ERROR');
    expect(result.body.message).toBe('Internal server error');
    expect(result.body.message).not.toContain('ssn');
    expect(result.category).toBe('unknown');
  });

  it('omits details entirely in production', async () => {
    const { mapper } = await buildMapper({ NODE_ENV: 'production' });
    const result = mapper.mapToErrorResponse(
      new Error('secret internal detail'),
    );
    expect('details' in result.body).toBe(false);
  });

  it('includes {name,message,stack} details outside production', async () => {
    const { mapper } = await buildMapper({ NODE_ENV: 'development' });
    const result = mapper.mapToErrorResponse(
      new TypeError('cannot read x of undefined'),
    );
    expect(result.body.details).toMatchObject({
      name: 'TypeError',
      message: 'cannot read x of undefined',
    });
    expect(typeof (result.body.details as { stack?: string }).stack).toBe(
      'string',
    );
  });

  it('handles a thrown non-Error value without throwing itself', async () => {
    const { mapper } = await buildMapper({ NODE_ENV: 'development' });
    expect(() =>
      mapper.mapToErrorResponse('a plain string throw'),
    ).not.toThrow();
    expect(() => mapper.mapToErrorResponse(undefined)).not.toThrow();
    expect(() => mapper.mapToErrorResponse({ weird: true })).not.toThrow();
    const result = mapper.mapToErrorResponse('a plain string throw');
    expect(result.body.code).toBe('INTERNAL_ERROR');
    expect(result.body.details).toMatchObject({ name: 'NonError' });
  });

  it('a plain-object AppError-LIKE value (duck-typed, not instanceof) is still Unknown — instanceof is the only test (§7)', async () => {
    const { mapper } = await buildMapper();
    const fake = {
      code: 'NOT_FOUND',
      httpStatus: 404,
      category: 'domain',
      message: 'looks real',
    };
    const result = mapper.mapToErrorResponse(fake);
    expect(result.category).toBe('unknown');
    expect(result.status).toBe(500);
  });
});
