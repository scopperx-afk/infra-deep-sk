/**
 * `validate()` unit tests, and the §14 "Reuse" parity test — Validation spec §3, §8, §9, §14.
 *
 * The parity block is the direct regression test for §3's claim that "one source of truth,
 * reused everywhere" actually holds: `validate()` and the Pipe must produce byte-for-byte
 * identical `ZodError.issues` for the same invalid input against the same schema object. If
 * the two paths ever fork (a `.safeParse()` here, a wrapper there), this is where it shows.
 */
import { z, ZodError } from 'zod';
import { createZodDto } from './dto/create-zod-dto';
import { ZodValidationPipe } from './pipes/zod-validation.pipe';
import { validate } from './validate';

// The spec's own examples, declared inline (see dto/create-zod-dto.spec.ts for why not shared).
const CreatePostSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  tags: z.array(z.string()).max(20).default([]),
});
class CreatePostDto extends createZodDto(CreatePostSchema) {}

const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  publishedOnly: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
class ListPostsQueryDto extends createZodDto(ListPostsQuerySchema) {}

const NestedSchema = z.object({
  author: z.object({ id: z.string().uuid(), displayName: z.string() }),
});
class NestedDto extends createZodDto(NestedSchema) {}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw, but the call returned normally');
}

describe('validate() (§9)', () => {
  it('returns the parsed value — defaults applied, as the Pipe would', () => {
    expect(
      validate(CreatePostSchema, { title: 'Hello', body: 'World' }),
    ).toEqual({
      title: 'Hello',
      body: 'World',
      tags: [],
    });
  });

  it('applies transforms and coercion (the §6 query schema works at a non-HTTP boundary too)', () => {
    expect(
      validate(ListPostsQuerySchema, { publishedOnly: 'false', page: '2' }),
    ).toEqual({
      page: 2,
      pageSize: 20,
      publishedOnly: false,
    });
  });

  it('works with any Zod schema, not only one wrapped by createZodDto()', () => {
    expect(validate(z.number().int(), 5)).toBe(5);
    expect(validate(z.array(z.string()), ['a'])).toEqual(['a']);
  });

  it('throws the raw ZodError — exact class, not a wrapper (§8, §9)', () => {
    const err = thrownBy(() => validate(CreatePostSchema, { body: 'World' }));
    expect(err).toBeInstanceOf(ZodError);
    expect((err as Error).constructor).toBe(ZodError);
    expect((err as ZodError).issues[0]).toMatchObject({
      path: ['title'],
      code: 'invalid_type',
    });
  });

  it('the ZodError carries no `retryable` flag — a malformed payload will not heal on retry, so Queue branches on instanceof ZodError itself (§9)', () => {
    const err = thrownBy(() => validate(CreatePostSchema, {}));
    expect(err).toBeInstanceOf(ZodError);
    expect(err).not.toHaveProperty('retryable');
    expect(err).not.toHaveProperty('httpStatus');
  });

  it('is a plain function with no DI: two parameters, callable with no Nest container in sight (§9)', () => {
    expect(typeof validate).toBe('function');
    expect(validate.length).toBe(2);
    expect(validate(z.string(), 'no container needed')).toBe(
      'no container needed',
    );
  });

  it("accepts a DTO's own schema static — the same object an HTTP endpoint validates with (§3)", () => {
    const viaDto = validate(CreatePostDto.schema, { title: 't', body: 'b' });
    const viaSchema = validate(CreatePostSchema, { title: 't', body: 'b' });
    expect(viaDto).toEqual(viaSchema);
  });

  it('a Queue-handler-shaped call site (spec §9 example) validates job.data and surfaces a ZodError to branch on', () => {
    // A real Queue handler is async; a sync throw inside it surfaces as a rejection, exactly as here.
    function handleCreatePostJob(job: { data: unknown }): Promise<string> {
      return Promise.resolve().then(
        () => validate(CreatePostSchema, job.data).title,
      );
    }
    return expect(
      handleCreatePostJob({ data: { body: 'no title' } }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('is synchronous by contract: an async refinement throws a plain Error (NOT a ZodError) — a programmer bug, correctly not mistaken for bad input', () => {
    const AsyncSchema = z.string().refine((v) => Promise.resolve(v.length > 0));
    const err = thrownBy(() => validate(AsyncSchema, 'x'));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ZodError);
  });

  it('does not mutate its input', () => {
    const input = Object.freeze({
      title: 'Hello',
      body: 'World',
      tags: Object.freeze(['a']),
    });
    expect(() => validate(CreatePostSchema, input)).not.toThrow();
  });
});

describe('Pipe ↔ validate() parity — one validation code path, not two (§3, §14 "Reuse")', () => {
  const pipe = new ZodValidationPipe();
  const viaPipe = (
    dto: typeof CreatePostDto | typeof ListPostsQueryDto | typeof NestedDto,
    value: unknown,
  ) => pipe.transform(value, { type: 'body', metatype: dto });

  const invalidCases: Array<
    [
      string,
      typeof CreatePostDto | typeof ListPostsQueryDto | typeof NestedDto,
      z.ZodType<unknown, z.ZodTypeDef, unknown>,
      unknown,
    ]
  > = [
    [
      'a missing required field',
      CreatePostDto,
      CreatePostSchema,
      { body: 'World' },
    ],
    [
      'several wrong fields at once',
      CreatePostDto,
      CreatePostSchema,
      { title: '', body: 5, tags: 'nope' },
    ],
    [
      'a body that is not an object',
      CreatePostDto,
      CreatePostSchema,
      'just a string',
    ],
    ['an absent body', CreatePostDto, CreatePostSchema, undefined],
    [
      'an over-long array (max 20)',
      CreatePostDto,
      CreatePostSchema,
      {
        title: 't',
        body: 'b',
        tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
      },
    ],
    [
      'an out-of-range query value',
      ListPostsQueryDto,
      ListPostsQuerySchema,
      { pageSize: '10000' },
    ],
    [
      'a non-canonical query boolean',
      ListPostsQueryDto,
      ListPostsQuerySchema,
      { publishedOnly: 'yes' },
    ],
    [
      'a nested path failure',
      NestedDto,
      NestedSchema,
      { author: { id: 'not-a-uuid', displayName: 'A' } },
    ],
  ];

  it.each(invalidCases)(
    'produces byte-for-byte identical ZodError.issues for %s',
    (_label, dto, schema, input) => {
      const pipeErr = thrownBy(() => viaPipe(dto, input)) as ZodError;
      const validateErr = thrownBy(() => validate(schema, input)) as ZodError;

      expect(pipeErr).toBeInstanceOf(ZodError);
      expect(validateErr).toBeInstanceOf(ZodError);
      // "byte-for-byte": compare the serialized form, not just structural equality.
      expect(JSON.stringify(pipeErr.issues)).toBe(
        JSON.stringify(validateErr.issues),
      );
      expect(pipeErr.message).toBe(validateErr.message);
    },
  );

  it('every parity case is a real failure (guards the parity test against vacuously comparing two non-throws)', () => {
    for (const [, dto, schema, input] of invalidCases) {
      expect(() => viaPipe(dto, input)).toThrow(ZodError);
      expect(() => validate(schema, input)).toThrow(ZodError);
    }
  });

  // Annotated like `invalidCases` above: the rows mix schemas with different output types, so
  // without it TypeScript infers a union of concrete schemas and cannot pick one T for validate().
  const validCases: Array<
    [
      string,
      typeof CreatePostDto | typeof ListPostsQueryDto,
      z.ZodType<unknown, z.ZodTypeDef, unknown>,
      unknown,
    ]
  > = [
    [
      'a minimal valid post',
      CreatePostDto,
      CreatePostSchema,
      { title: 'Hello', body: 'World' },
    ],
    [
      'a full valid post',
      CreatePostDto,
      CreatePostSchema,
      { title: 'Hello', body: 'World', tags: ['a'] },
    ],
    [
      'a coerced query',
      ListPostsQueryDto,
      ListPostsQuerySchema,
      { page: '3', publishedOnly: 'false' },
    ],
    [
      'an empty query (all defaults)',
      ListPostsQueryDto,
      ListPostsQuerySchema,
      {},
    ],
  ];

  it.each(validCases)(
    'also produces identical OUTPUT for valid input: %s',
    (_label, dto, schema, input) => {
      expect(viaPipe(dto, input)).toEqual(validate(schema, input));
    },
  );

  it('both paths share the very same schema object — there is no second copy to drift (§3)', () => {
    expect(CreatePostDto.schema).toBe(CreatePostSchema);
    expect(ListPostsQueryDto.schema).toBe(ListPostsQuerySchema);
  });
});
