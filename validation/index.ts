/**
 * validation/index.ts — the ONLY public surface of the Validation module (§12),
 * mirroring config/, tracing/, logger/ and errors/ index.ts. Everything else is
 * unreachable from outside `validation/`, enforced by the same ESLint boundary
 * rule every other module uses.
 *
 * `ZodValidationPipe` IS exported (E-V1, accepted): `APP_PIPE` does not reach WebSocket
 * gateways, so each gateway applies it with `@UsePipes(ZodValidationPipe)`, exactly as
 * Errors' `WsExceptionFilter` is applied. HTTP handlers must never do this (E-V6) —
 * `APP_PIPE` already covers them, and a double parse breaks transform schemas.
 *
 * Added by the production review (E-V8 … E-V12, see the guide's decision log):
 *  - `queryBoolean()` / `queryInt()` — the two query-string coercions authors get wrong (§6);
 *  - `findUnvalidatedRouteInputs()` / `assertRouteInputsValidated()` — a CI audit that fails when a
 *    handler takes a `@Body()` / whole-object `@Query()` that is not a `createZodDto()` class (the Pipe's
 *    narrow scope makes that mistake otherwise invisible).
 *
 * What is NOT here, on purpose:
 *  - any token — `validation.tokens.ts` is intentionally empty (§12).
 *  - any schema — Validation provides the mechanism, domain modules own the
 *    business shapes (§3).
 */
export { createZodDto } from './dto/create-zod-dto';
export type { ZodDto } from './dto/create-zod-dto';
export { validate } from './validate';
export { queryBoolean, queryInt } from './schemas/query-schemas';
export {
  findUnvalidatedRouteInputs,
  assertRouteInputsValidated,
} from './testing/route-input-audit';
export type {
  RouteInputAuditOptions,
  UnvalidatedRouteInput,
} from './testing/route-input-audit';
export { ZodValidationPipe } from './pipes/zod-validation.pipe';
export { ValidationModule } from './validation.module';
