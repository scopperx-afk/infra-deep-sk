/**
 * `ZodValidationPipe` unit tests — Validation spec §4, §5, §6, §7, §8, §14 ("Pipe",
 * "Coercion"). The HTTP-adapter half of §14 (real query-string delivery through Express,
 * `APP_PIPE` wiring) is in `validation.module.spec.ts`; the Errors-side half is in
 * `errors/integration/validation-pipe.integration.spec.ts`.
 *
 * Assertions on failures target `code` and `path`, never `message` text: message wording
 * is Zod-version-specific (Appendix A's "Required" is Zod 3 phrasing) and is not this
 * module's contract — Errors' mapper passes it through as-is.
 */
import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { z, ZodError } from 'zod';
import { createZodDto } from '../dto/create-zod-dto';
import { ZodValidationPipe } from './zod-validation.pipe';

// ── Schemas: the spec's own examples (§4, §5, §6), declared inline — see create-zod-dto.spec.ts ──
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

const meta = (
  type: ArgumentMetadata['type'],
  metatype: ArgumentMetadata['metatype'],
  data?: string,
): ArgumentMetadata => ({
  type,
  metatype,
  data,
});

/** Run the pipe and return what it threw (or fail loudly if it did not throw). */
function thrownBy(
  pipe: PipeTransform,
  value: unknown,
  metadata: ArgumentMetadata,
): unknown {
  try {
    pipe.transform(value, metadata);
  } catch (e) {
    return e;
  }
  throw new Error('expected the pipe to throw, but it returned normally');
}

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe();

  describe('a createZodDto() parameter (§4)', () => {
    it('returns a valid payload parsed — defaults applied, equal to the input otherwise', () => {
      const out = pipe.transform(
        { title: 'Hello', body: 'World' },
        meta('body', CreatePostDto),
      );
      expect(out).toEqual({ title: 'Hello', body: 'World', tags: [] });
    });

    it('passes a fully-specified valid payload through structurally unchanged', () => {
      const input = { title: 'Hello', body: 'World', tags: ['a', 'b'] };
      expect(pipe.transform(input, meta('body', CreatePostDto))).toEqual(input);
    });

    it('returns a PLAIN object, not a CreatePostDto instance (corrects §14\'s "still instanceof" wording)', () => {
      // The DTO class is a type carrier (see create-zod-dto.ts). `.parse()` output is a fresh plain object;
      // the compile-time guarantee that it matches the DTO's shape is pinned in create-zod-dto.types.spec.ts.
      const out = pipe.transform(
        { title: 'Hello', body: 'World' },
        meta('body', CreatePostDto),
      );
      expect(out).not.toBeInstanceOf(CreatePostDto);
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    });

    it('does not mutate its input (a frozen input must not throw)', () => {
      const input = Object.freeze({
        title: 'Hello',
        body: 'World',
        tags: Object.freeze(['a']),
      });
      expect(() =>
        pipe.transform(input, meta('body', CreatePostDto)),
      ).not.toThrow();
      expect(input).toEqual({ title: 'Hello', body: 'World', tags: ['a'] });
    });

    it("drops keys the schema does not declare — Zod's default object policy, not something this Pipe adds", () => {
      const out = pipe.transform(
        { title: 'Hello', body: 'World', admin: true },
        meta('body', CreatePostDto),
      );
      expect(out).toEqual({ title: 'Hello', body: 'World', tags: [] });
    });
  });

  describe('the failure path is a raw ZodError, never wrapped (§8, §15 #1)', () => {
    it("throws a ZodError whose class is exactly Zod's own — not a subclass, not a wrapper", () => {
      const err = thrownBy(
        pipe,
        { body: 'World' },
        meta('body', CreatePostDto),
      );
      expect(err).toBeInstanceOf(ZodError);
      expect((err as Error).constructor).toBe(ZodError);
      expect((err as Error).name).toBe('ZodError');
    });

    it('carries the field-level issues unmodified (path + code)', () => {
      const err = thrownBy(
        pipe,
        { body: 'World' },
        meta('body', CreatePostDto),
      ) as ZodError;
      expect(err.issues).toHaveLength(1);
      expect(err.issues[0]).toMatchObject({
        path: ['title'],
        code: 'invalid_type',
      });
    });

    it('is the same error the schema itself would throw — nothing added, nothing removed', () => {
      const pipeErr = thrownBy(
        pipe,
        { body: 'World' },
        meta('body', CreatePostDto),
      ) as ZodError;
      let schemaErr: ZodError | undefined;
      try {
        CreatePostSchema.parse({ body: 'World' });
      } catch (e) {
        schemaErr = e as ZodError;
      }
      expect(pipeErr.issues).toEqual(schemaErr?.issues);
      expect(pipeErr.message).toBe(schemaErr?.message);
    });

    it('is not wrapped: no `cause`, and no AppError-style `code`/`httpStatus`/`retryable` fields', () => {
      const err = thrownBy(
        pipe,
        { body: 'World' },
        meta('body', CreatePostDto),
      ) as Record<string, unknown>;
      expect(err.cause).toBeUndefined();
      expect(err).not.toHaveProperty('httpStatus');
      expect(err).not.toHaveProperty('retryable');
      expect(err).not.toHaveProperty('category');
    });

    it('reports every failing field in ONE throw, not just the first', () => {
      const err = thrownBy(
        pipe,
        { title: '', body: 5, tags: 'nope' },
        meta('body', CreatePostDto),
      ) as ZodError;
      expect(err.issues.map((i) => i.path.join('.')).sort()).toEqual([
        'body',
        'tags',
        'title',
      ]);
    });

    it.each([
      ['undefined (a missing body)', undefined],
      ['null', null],
      ['a string', 'not an object'],
      ['a number', 42],
      ['an array', []],
    ])(
      'rejects %s as a CreatePostDto body, at the root path',
      (_label, value) => {
        const err = thrownBy(
          pipe,
          value,
          meta('body', CreatePostDto),
        ) as ZodError;
        expect(err).toBeInstanceOf(ZodError);
        expect(err.issues[0].path).toEqual([]);
        expect(err.issues[0].code).toBe('invalid_type');
      },
    );

    it('stays usable after a failure — the Pipe holds no state between calls', () => {
      thrownBy(pipe, {}, meta('body', CreatePostDto));
      expect(
        pipe.transform(
          { title: 'ok', body: 'ok' },
          meta('body', CreatePostDto),
        ),
      ).toEqual({
        title: 'ok',
        body: 'ok',
        tags: [],
      });
      thrownBy(pipe, null, meta('body', CreatePostDto));
      expect(
        pipe.transform(
          { title: 'again', body: 'again' },
          meta('body', CreatePostDto),
        ),
      ).toMatchObject({
        title: 'again',
      });
    });
  });

  describe('deliberately narrow scope: non-Zod parameters pass through untouched (§4)', () => {
    // §14: "verified against a plain string/number parameter specifically".
    it("@Param('id') id: string — metatype String — is returned as the very same value", () => {
      expect(pipe.transform('42', meta('param', String, 'id'))).toBe('42');
    });

    it('a number-typed parameter (metatype Number) is returned as the very same value, NOT coerced or validated', () => {
      expect(pipe.transform(7, meta('query', Number, 'n'))).toBe(7);
    });

    it("does not coerce a string into the number its metatype declares — coercion is the schema author's job (§6)", () => {
      expect(pipe.transform('7', meta('query', Number, 'n'))).toBe('7');
    });

    it.each<[string, ArgumentMetadata['metatype']]>([
      ['String', String],
      ['Number', Number],
      ['Boolean', Boolean],
      ['Array', Array],
      ['Date', Date],
      ['Object (what a hand-written interface reflects as)', Object],
      ['undefined (no declared type at all)', undefined],
    ])(
      'metatype %s passes ANY value through by reference, even a nonsensical one',
      (_label, metatype) => {
        const weird = { definitely: ['not', 'validated'] };
        expect(pipe.transform(weird, meta('body', metatype))).toBe(weird);
        expect(
          pipe.transform(undefined, meta('body', metatype)),
        ).toBeUndefined();
        expect(pipe.transform(null, meta('body', metatype))).toBeNull();
      },
    );

    it('a plain class that never opted in passes through, however schema-like it looks', () => {
      class HandWrittenDto {
        title!: string;
      }
      const value = { title: 123 }; // wrong type on purpose — this Pipe must not know or care
      expect(pipe.transform(value, meta('body', HandWrittenDto))).toBe(value);
    });

    it('a class with a `schema` static but no isZodDto marker is NOT treated as a Zod DTO — never infers (§4)', () => {
      class ForeignDto {
        static readonly schema = z.object({ title: z.string() });
      }
      const value = { title: 123 };
      expect(pipe.transform(value, meta('body', ForeignDto))).toBe(value);
    });

    it('a class whose isZodDto is falsy passes through', () => {
      class OptedOut {
        static readonly isZodDto = false;
        static readonly schema = z.object({ title: z.string() });
      }
      const value = { title: 123 };
      expect(pipe.transform(value, meta('body', OptedOut))).toBe(value);
    });
  });

  describe('uniform across metadata.type (§6) — the Pipe never branches on it', () => {
    it.each<ArgumentMetadata['type']>(['body', 'query', 'param', 'custom'])(
      'validates a DTO identically when the parameter is a %s',
      (type) => {
        expect(
          pipe.transform({ title: 'T', body: 'B' }, meta(type, CreatePostDto)),
        ).toEqual({
          title: 'T',
          body: 'B',
          tags: [],
        });
        expect(thrownBy(pipe, {}, meta(type, CreatePostDto))).toBeInstanceOf(
          ZodError,
        );
      },
    );

    it("ignores `metadata.data` (the `@Body('field')` selector): the value Nest hands over is what is validated", () => {
      expect(
        pipe.transform(
          { title: 'T', body: 'B' },
          meta('body', CreatePostDto, 'post'),
        ),
      ).toEqual({
        title: 'T',
        body: 'B',
        tags: [],
      });
    });
  });

  describe('query-string coercion — the schema author declares it, the Pipe just parses (§6)', () => {
    // Values below are the STRINGS an HTTP adapter actually delivers for query parameters.
    it('?publishedOnly=false resolves to the boolean `false` — the direct regression for the z.coerce.boolean() footgun', () => {
      // z.coerce.boolean() would yield `true` here, because it is Boolean('false') and any non-empty
      // string is truthy. The explicit enum+transform shape (§6's hard rule) must not.
      const out = pipe.transform(
        { publishedOnly: 'false' },
        meta('query', ListPostsQueryDto),
      ) as {
        publishedOnly: unknown;
      };
      expect(out.publishedOnly).toBe(false);
    });

    it('?publishedOnly=true resolves to the boolean `true`', () => {
      const out = pipe.transform(
        { publishedOnly: 'true' },
        meta('query', ListPostsQueryDto),
      ) as {
        publishedOnly: unknown;
      };
      expect(out.publishedOnly).toBe(true);
    });

    it('an absent query yields every default, with publishedOnly as a real boolean', () => {
      expect(pipe.transform({}, meta('query', ListPostsQueryDto))).toEqual({
        page: 1,
        pageSize: 20,
        publishedOnly: true,
      });
    });

    it.each(['yes', 'no', '1', '0', 'TRUE', 'False', ' true', ''])(
      'rejects the non-canonical boolean spelling %j instead of guessing what it meant',
      (spelling) => {
        const err = thrownBy(
          pipe,
          { publishedOnly: spelling },
          meta('query', ListPostsQueryDto),
        ) as ZodError;
        expect(err).toBeInstanceOf(ZodError);
        expect(err.issues[0].path).toEqual(['publishedOnly']);
      },
    );

    it('rejects a repeated query key (Express delivers an array) rather than silently taking one value', () => {
      const err = thrownBy(
        pipe,
        { publishedOnly: ['true', 'false'] },
        meta('query', ListPostsQueryDto),
      ) as ZodError;
      expect(err.issues[0].path).toEqual(['publishedOnly']);
    });

    it('coerces numeric strings to numbers', () => {
      expect(
        pipe.transform(
          { page: '3', pageSize: '50' },
          meta('query', ListPostsQueryDto),
        ),
      ).toMatchObject({
        page: 3,
        pageSize: 50,
      });
    });

    it('rejects an out-of-range value — it is NEVER silently clamped (§6)', () => {
      const err = thrownBy(
        pipe,
        { pageSize: '10000' },
        meta('query', ListPostsQueryDto),
      ) as ZodError;
      expect(err).toBeInstanceOf(ZodError);
      expect(err.issues[0]).toMatchObject({
        path: ['pageSize'],
        code: 'too_big',
      });
    });

    it.each([
      ['page=0 (below the minimum)', { page: '0' }, 'too_small'],
      ['page=-1', { page: '-1' }, 'too_small'],
      ['page= (empty string coerces to 0)', { page: '' }, 'too_small'],
      ['page=1.5 (not an integer)', { page: '1.5' }, 'invalid_type'],
      ['page=abc (NaN)', { page: 'abc' }, 'invalid_type'],
    ])('rejects %s', (_label, query, code) => {
      const err = thrownBy(
        pipe,
        query,
        meta('query', ListPostsQueryDto),
      ) as ZodError;
      expect(err.issues[0]).toMatchObject({ path: ['page'], code });
    });

    it('the Pipe makes no range distinction of its own: out-of-range and wrong-shape are both just a ZodError (§6)', () => {
      const tooBig = thrownBy(
        pipe,
        { pageSize: '10000' },
        meta('query', ListPostsQueryDto),
      );
      const wrongShape = thrownBy(
        pipe,
        { pageSize: 'abc' },
        meta('query', ListPostsQueryDto),
      );
      expect((tooBig as Error).constructor).toBe(
        (wrongShape as Error).constructor,
      );
    });
  });

  describe('every Zod capability passes through unchanged — no second validation vocabulary (§5)', () => {
    const NestedSchema = z.object({
      author: z.object({ id: z.string().uuid(), displayName: z.string() }),
    });
    class NestedDto extends createZodDto(NestedSchema) {}

    const RangeSchema = z
      .object({ startDate: z.coerce.date(), endDate: z.coerce.date() })
      .superRefine((v, ctx) => {
        if (v.endDate <= v.startDate)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['endDate'],
            message: 'must be after startDate',
          });
      });
    class RangeDto extends createZodDto(RangeSchema) {}

    const PaymentWrapperSchema = z.object({
      payment: z.discriminatedUnion('type', [
        z.object({ type: z.literal('card'), last4: z.string().length(4) }),
        z.object({ type: z.literal('bank_transfer'), iban: z.string().min(5) }),
      ]),
    });
    class PaymentDto extends createZodDto(PaymentWrapperSchema) {}

    it('nested objects are checked in one parse() call, with a dotted-ready path', () => {
      const err = thrownBy(
        pipe,
        { author: { id: 'not-a-uuid', displayName: 'A' } },
        meta('body', NestedDto),
      ) as ZodError;
      expect(err.issues).toHaveLength(1);
      expect(err.issues[0].path).toEqual(['author', 'id']);
    });

    it('a valid nested payload is accepted', () => {
      const value = {
        author: {
          id: '3f2b8c6e-5d41-4a2e-9c2b-7a1f0e9d8c11',
          displayName: 'A',
        },
      };
      expect(pipe.transform(value, meta('body', NestedDto))).toEqual(value);
    });

    it('superRefine cross-field rules run (endDate must be after startDate)', () => {
      const err = thrownBy(
        pipe,
        { startDate: '2025-02-01', endDate: '2025-01-01' },
        meta('body', RangeDto),
      ) as ZodError;
      expect(err.issues[0]).toMatchObject({
        path: ['endDate'],
        code: 'custom',
      });
    });

    it('z.coerce.date() — narrow, per-field — turns an ISO string into a Date, and rejects garbage', () => {
      const ok = pipe.transform(
        { startDate: '2025-01-01', endDate: '2025-02-01' },
        meta('body', RangeDto),
      ) as {
        startDate: unknown;
      };
      expect(ok.startDate).toBeInstanceOf(Date);
      const err = thrownBy(
        pipe,
        { startDate: 'nope', endDate: '2025-02-01' },
        meta('body', RangeDto),
      ) as ZodError;
      expect(err.issues[0]).toMatchObject({
        path: ['startDate'],
        code: 'invalid_date',
      });
    });

    it('discriminatedUnion accepts each exclusive shape', () => {
      expect(
        pipe.transform(
          { payment: { type: 'card', last4: '4242' } },
          meta('body', PaymentDto),
        ),
      ).toEqual({
        payment: { type: 'card', last4: '4242' },
      });
      expect(
        pipe.transform(
          {
            payment: { type: 'bank_transfer', iban: 'DE89370400440532013000' },
          },
          meta('body', PaymentDto),
        ),
      ).toBeDefined();
    });

    it('discriminatedUnion rejects a shape that tries to be both — the inconsistent combination is flagged, not let through', () => {
      const err = thrownBy(
        pipe,
        { payment: { type: 'card', iban: 'DE89370400440532013000' } },
        meta('body', PaymentDto),
      ) as ZodError;
      expect(err.issues[0].path).toEqual(['payment', 'last4']);
    });

    it('discriminatedUnion rejects an unknown discriminator', () => {
      const err = thrownBy(
        pipe,
        { payment: { type: 'cheque' } },
        meta('body', PaymentDto),
      ) as ZodError;
      expect(err.issues[0]).toMatchObject({
        path: ['payment', 'type'],
        code: 'invalid_union_discriminator',
      });
    });
  });

  describe('shape only — never sanitize, never size-limit (§7, §15 #4)', () => {
    const CommentSchema = z.object({ text: z.string().min(1) });
    class CommentDto extends createZodDto(CommentSchema) {}

    it('a string that passes shape validation comes back byte-for-byte identical, <script> and all', () => {
      const text = `<script>alert("x")</script> & "quotes" \u0000 ${'  '}trailing  `;
      const out = pipe.transform({ text }, meta('body', CommentDto)) as {
        text: string;
      };
      expect(out.text).toBe(text);
    });

    it("applies no size limit of its own — that is HTTP's guard, not this module's (§7)", () => {
      const text = 'x'.repeat(2_000_000);
      expect(() =>
        pipe.transform({ text }, meta('body', CommentDto)),
      ).not.toThrow();
    });
  });

  describe('no constructor dependencies (§4, §12)', () => {
    it('can be constructed with no arguments — there is nothing to inject', () => {
      expect(() => new ZodValidationPipe()).not.toThrow();
      expect(ZodValidationPipe.length).toBe(0);
    });

    it("declares no design:paramtypes — nothing for Nest's injector to resolve", () => {
      expect(
        Reflect.getMetadata('design:paramtypes', ZodValidationPipe) ?? [],
      ).toEqual([]);
    });

    it('is a PipeTransform: exposes transform(value, metadata)', () => {
      const asPipe: PipeTransform = new ZodValidationPipe();
      expect(typeof asPipe.transform).toBe('function');
    });
  });
});
