/**
 * `createZodDto()` and the `ZodDto` interface — Validation spec §4. This file is
 * the mechanism behind §3's "one schema, every boundary": a schema is defined
 * once (in whichever domain module owns the business shape) and this factory
 * turns it into a class Nest can see.
 *
 * WHY a class factory, not a decorator or a registry: Nest already resolves a
 * handler parameter's declared type (`@Body() dto: CreatePostDto`) into
 * `ArgumentMetadata.metatype`. A class that carries its schema as a STATIC
 * therefore needs no `Reflector`, no per-route decorator and no second place a
 * schema must be registered — `class CreatePostDto extends createZodDto(Schema) {}`
 * IS the registration (§4). `static` members are inherited through `extends`, so
 * the subclass is still recognized by `isZodDto` without redeclaring anything.
 *
 * The produced class is a TYPE CARRIER and a metatype marker — never a runtime
 * object model. `new CreatePostDto()` yields an empty object, and the Pipe
 * (§4) never constructs one: it returns `schema.parse()`'s own output, a plain
 * object. That is why `T` here is purely a compile-time claim about the parsed
 * shape (`z.infer`), and why returning the class typed as `ZodDto<z.infer<T>>` is sound for
 * its only use. No cast is needed — TypeScript accepts the class against the declared return
 * type, and `create-zod-dto.types.spec.ts` pins that the inference claim survives.
 *
 * ── Deviation D1 (typing only, no behavioral change) ─────────────────────────
 * §4 declares `schema: ZodSchema<T>`. In Zod 3 that alias is
 * `ZodType<T, ZodTypeDef, T>` — it pins the schema's INPUT type to its OUTPUT
 * type, which is false for any schema using `.default()`/`.transform()`/
 * `z.coerce.*` (i.e. §6's own `ListPostsQuerySchema`, whose `page` is
 * `number | undefined` going in and `number` coming out). Passing such a schema
 * to the sibling `validate()` with the literal signature fails to compile
 * (TS2345, verified against §6's example). The input slot is therefore widened to
 * `unknown`: `T` (the output type) is unchanged, and `.parse(value: unknown)` —
 * the only call the Pipe makes — is unaffected. Same widening in `validate.ts`.
 *
 * ── Known limitation L1 (spec-inherent, deliberately NOT worked around) ───────
 * `new (): T` plus `extends` means TypeScript requires `T` to be an object type.
 * A schema whose TOP level is a union — notably §5's `discriminatedUnion` — cannot
 * be a DTO base class (TS2509). Nest it one level down instead:
 * `z.object({ payment: z.discriminatedUnion(...) })`. Pinned by a compile-time
 * test so the behavior is documented rather than discovered.
 */
import type { z, ZodSchema, ZodType, ZodTypeDef } from 'zod';

export interface ZodDto<T = unknown> {
  new (): T;
  /** Output type `T` is what `.parse()` returns; the input slot is `unknown` — see Deviation D1. */
  readonly schema: ZodType<T, ZodTypeDef, unknown>;
  /** Literal `true` is the Pipe's sole recognition signal (§4) — never inferred from the type. */
  readonly isZodDto: true;
}

export function createZodDto<T extends ZodSchema>(
  schema: T,
): ZodDto<z.infer<T>> {
  class AugmentedZodDto {
    static readonly schema = schema;
    // `as const` keeps the literal `true` type, so `ZodDto['isZodDto']` is `true`, not `boolean`.
    static readonly isZodDto = true as const;
  }
  return AugmentedZodDto;
}
