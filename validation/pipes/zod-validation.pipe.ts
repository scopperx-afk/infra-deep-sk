/**
 * `ZodValidationPipe` — Validation spec §4, §6, §8. The one pipe applied to every
 * handler parameter in the system (registered once via `APP_PIPE`, §10). It does
 * exactly one thing: when a parameter's declared type is a `createZodDto()` class,
 * call that class's schema's `.parse()` on the incoming value.
 *
 * NO CONSTRUCTOR DEPENDENCIES (§4). The schema is read straight off
 * `ArgumentMetadata.metatype` — the object Nest already resolves from the
 * parameter's declared type — so there is no `Reflector`, no per-route
 * decorator and nothing for `validation.tokens.ts` to hold (§12). This is also
 * why the class declares no constructor at all: a constructor here would be the
 * first step toward a dependency §2 forbids.
 *
 * DELIBERATELY NARROW SCOPE (§4). A parameter whose declared type is not a
 * `createZodDto()` class — a plain `string`, a hand-written interface (which
 * reflects as `Object`), `@Param('id') id: string` — is returned untouched,
 * by reference, completely unexamined. This Pipe validates what was declared to
 * be validated and never infers a schema for a type that did not opt in.
 * `isZodDto` is the sole signal; `String`/`Number`/`Object` have no such static.
 * (That narrowness makes a forgotten DTO INVISIBLE — `@Body() b: SomeInterface` is
 * accepted unvalidated, silently. `testing/route-input-audit.ts` exists to catch it in CI.)
 *
 * UNIFORM ACROSS `metadata.type` (§6). The Pipe never branches on
 * `'body' | 'query' | 'param' | 'custom'`. Query strings and route params arrive
 * as strings, so it is the SCHEMA AUTHOR's job to declare `z.coerce.*` /
 * `z.enum([...]).transform(...)` where the transport needs it — not the Pipe's job
 * to guess. That keeps the mechanism honest: one `.parse()` call, everywhere.
 *
 * THE FAILURE PATH IS A RAW `ZodError` (§8). `.parse()`, never `.safeParse()`; no
 * try/catch; nothing imported from `errors/`. Wrapping it in Errors'
 * `ValidationError` would need a lateral Layer 1 → Layer 1 import
 * (Validation → Errors), which this project forbids in both directions. Errors'
 * mapper already recognizes a ZodError as its case 3 and produces the
 * identical 400 `VALIDATION_ERROR` body, so no coordination is needed.
 *
 * SHAPE ONLY (§7, §15 #4). The value is never stripped, escaped or sanitized
 * here — `z.string()` accepting `<script>` is correct; sanitization depends on
 * what the string becomes and belongs to Security or the domain. Size limits
 * are HTTP's (§7), and nothing here logs: Errors' filter logs every caught
 * exception exactly once (§15 #8).
 *
 * EXPORTED from `index.ts` for exactly one reason (E-V1, accepted): WebSocket
 * gateways. Nest never consults the global `APP_PIPE` for a gateway's
 * `@MessageBody()` (see `validation.module.ts`), so a gateway must apply this very
 * class itself with `@UsePipes(ZodValidationPipe)` — the same pattern Errors uses
 * for `WsExceptionFilter`. It is the SAME class, not a second `WsZodValidationPipe`
 * (§15 #7 still stands).
 *
 * APPLYING IT TO AN HTTP HANDLER IS NOW HARMLESS (E-V6, hardened E-V8). There `APP_PIPE`
 * already runs it; Nest runs both, and the second `.parse()` used to receive the FIRST
 * parse's OUTPUT — harmless for idempotent schemas and fatal for §6's mandated boolean
 * shape (`z.enum(['true','false']).transform(...)` — the transformed `true` is no longer a
 * valid enum member): every request failed, defaults included (reproduced). A value this
 * pipe has already produced FROM THE SAME SCHEMA is now recognised and returned as is.
 * (Keyed by schema on purpose: an object one schema produced must still be validated by a
 * DIFFERENT schema — a permissive `z.any()` DTO must not exempt the same body from a strict one.)
 * It is still wrong to do — `APP_PIPE` already covers HTTP — it just no longer breaks the route.
 */
import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodDto } from '../dto/create-zod-dto';

/** output object → the schema that produced it (weak: never keeps a request's data alive). */
const producedBy = new WeakMap<object, unknown>();

/** WebSocket gateways MUST apply this explicitly via `@UsePipes(ZodValidationPipe)` (APP_PIPE does not reach them — E-V1); never on HTTP handlers, where APP_PIPE already applies and a second parse breaks transform schemas (E-V6). */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    // `metatype` is Nest's `Type<any> | undefined`; narrowing it to ZodDto is sound only because the
    // very next line checks the discriminating static before anything ZodDto-specific is touched.
    const metatype = metadata.metatype as ZodDto | undefined;
    if (!metatype?.isZodDto) return value; // not a Zod-declared param — pass through untouched (§4 scope rule)

    const schema = metatype.schema;
    // A class that CLAIMS to be a DTO but carries no schema (a hand-written `static isZodDto = true`, a
    // mocked DTO, a version mismatch) used to fail as `TypeError: Cannot read properties of undefined`
    // deep inside the pipe — a bare 500 with no hint of the cause. Say what is wrong instead.
    if (typeof schema?.parse !== 'function')
      throw new TypeError(
        `${metatype.name || 'A class'} is marked isZodDto but carries no Zod schema — declare it with createZodDto(schema)`,
      );

    if (typeof value === 'object' && value !== null && producedBy.get(value) === schema)
      return value; // already parsed by THIS schema (APP_PIPE + an explicit @UsePipes) — never parse an output again

    const parsed = schema.parse(value); // throws a raw ZodError on failure — never caught here (§8)
    if (typeof parsed === 'object' && parsed !== null) producedBy.set(parsed, schema);
    return parsed;
  }
}
