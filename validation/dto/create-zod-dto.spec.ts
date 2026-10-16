/**
 * Runtime behavior of `createZodDto()` — Validation spec §4, §3. The COMPILE-TIME half
 * (that `ZodDto<T>` preserves `z.infer<T>`) lives in `create-zod-dto.types.spec.ts`,
 * because this project's ts-jest runs transpile-only (`isolatedModules: true`) and
 * would never notice a type error in a spec like this one.
 *
 * Schemas are declared inline, per spec file: §3 says the domain owns its schemas and this
 * module ships none, so there is deliberately no shared fixtures file under `validation/`
 * (it would be scanned as production source by `boundary.spec.ts`, which pins §13's exact tree).
 */
import { z } from 'zod';
import { createZodDto } from './create-zod-dto';

const CreatePostSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  tags: z.array(z.string()).max(20).default([]),
});
class CreatePostDto extends createZodDto(CreatePostSchema) {}

describe('createZodDto() — runtime (§4)', () => {
  it('attaches the schema it was given as a static, by reference — one source of truth, never a copy (§3)', () => {
    const Dto = createZodDto(CreatePostSchema);
    expect(Dto.schema).toBe(CreatePostSchema);
  });

  it('marks the class with the literal `isZodDto === true` the Pipe keys on', () => {
    expect(createZodDto(CreatePostSchema).isZodDto).toBe(true);
  });

  it('a subclass declared with `extends` inherits both statics — `class X extends createZodDto(S) {}` IS the registration (§4)', () => {
    expect(CreatePostDto.isZodDto).toBe(true);
    expect(CreatePostDto.schema).toBe(CreatePostSchema);
    // inherited through the prototype chain of the constructors, not redeclared on the subclass
    expect(Object.prototype.hasOwnProperty.call(CreatePostDto, 'schema')).toBe(
      false,
    );
  });

  it('two DTO classes over the same schema are distinct classes sharing ONE schema object', () => {
    class A extends createZodDto(CreatePostSchema) {}
    class B extends createZodDto(CreatePostSchema) {}
    expect(A).not.toBe(B);
    expect(A.schema).toBe(B.schema);
  });

  it('DTOs over different schemas never share statics', () => {
    const Other = createZodDto(z.object({ id: z.string() }));
    expect(Other.schema).not.toBe(CreatePostDto.schema);
  });

  it('the attached schema is the real, working Zod schema (parse applies defaults)', () => {
    expect(CreatePostDto.schema.parse({ title: 't', body: 'b' })).toEqual({
      title: 't',
      body: 'b',
      tags: [],
    });
  });

  it('is a type carrier, not an object model: `new Dto()` takes no arguments and yields no validated state', () => {
    // Pins the header's claim: the Pipe returns schema.parse()'s plain output and never constructs
    // an instance, so nothing may rely on `new CreatePostDto()` carrying any fields.
    const instance = new CreatePostDto();
    expect(Object.keys(instance)).toEqual([]);
  });

  it('does not mutate or wrap the schema it was handed', () => {
    const before = CreatePostSchema.shape;
    createZodDto(CreatePostSchema);
    expect(CreatePostSchema.shape).toBe(before);
  });
});
