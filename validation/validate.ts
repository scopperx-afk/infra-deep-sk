/**
 * `validate()` — Validation spec §9. The plain-function counterpart of
 * `ZodValidationPipe` for boundaries that have no Nest request cycle: Queue job
 * handlers and Event consumers. Both need the same guarantee an HTTP endpoint
 * gets, from the very same schema object (§3) — never a redeclared copy
 * (§15 #3).
 *
 * WHY a plain function with no DI: the identical pattern as Tracing's
 * `getTraceContext()`, HTTP's `getRequestContext()` and Logger's
 * `enrichLogContext()` — a cross-cutting primitive with no reason to force a
 * constructor injection onto every call site. It also keeps this module's
 * zero-dependency promise (§2): nothing here can be resolved from a container
 * because nothing here needs to be.
 *
 * WHY `.parse()` and not `.safeParse()`: ONE failure contract. A failed
 * validation throws the raw `ZodError` Zod itself constructs, exactly as the
 * Pipe does (§8), so the HTTP path and this path cannot drift into two
 * validation code paths (§14's byte-for-byte parity test pins this). We do not
 * catch, wrap or log it (§8, §15 #1, #8).
 *
 * That raw `ZodError` is NOT an `AppError` and carries no `retryable` flag. This
 * is by design, not a gap (§9): a malformed payload will not become valid by
 * being retried, so Queue's own handler is responsible for treating a
 * `ZodError` at this boundary as non-retryable (straight to DLQ) by branching
 * on `instanceof ZodError` — this module invents no wrapper just to carry a boolean.
 *
 * Synchronous by contract: a schema containing an async refinement/transform
 * makes `.parse()` throw a plain `Error` (NOT a `ZodError`) — Zod 3's "use
 * .parseAsync instead". That is a programmer error, and surfacing it as a
 * non-Zod throw is the correct signal (Errors' mapper files it under Unknown,
 * the "real bug" bucket). It is deliberately not papered over with a second,
 * async entry point — §9 specifies exactly one function.
 *
 * ── Deviation D1 (typing only) ─────────────────────────────────────────────
 * §9 writes `schema: ZodSchema<T>`, which pins Zod's input type to its output
 * type and fails to compile for schemas using `.default()`/`.transform()` (see
 * `dto/create-zod-dto.ts` for the full account). The input slot is widened to
 * `unknown`; `T` remains the OUTPUT type and every call site in the spec
 * (`validate(CreatePostSchema, job.data)`) is unchanged.
 */
import type { ZodType, ZodTypeDef } from 'zod';

export function validate<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  data: unknown,
): T {
  return schema.parse(data);
}
