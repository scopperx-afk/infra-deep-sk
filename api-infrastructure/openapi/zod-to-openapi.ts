/**
 * Zod → OpenAPI 3 schema conversion — API Infrastructure spec §9.1.
 *
 * ── Deviation E-A12 (toolchain) ─────────────────────────────────────────────────────────────
 * §9.1 recommends `nestjs-zod`. That package works by patching `@nestjs/swagger` for classes
 * produced by ITS OWN `createZodDto`. This project's Validation module ships its own
 * `createZodDto` (Validation spec §4) — a different class factory — so `nestjs-zod`'s patch would
 * have nothing to patch, and adopting it would mean either replacing Validation's DTO factory or
 * running two parallel ones. The spec's actual requirement is "one pipeline, one document, no
 * parallel documentation source to drift"; the smallest thing that meets it is a pure
 * schema-to-schema conversion over the SAME Zod schemas the pipe validates with, fed to
 * `@nestjs/swagger`'s own decorators. `zod-to-json-schema` (Zod 3) is that converter; the
 * `ApiZodBody`/`ApiZodQuery` decorators in `api-zod.decorators.ts` close the request side.
 *
 * Conversion is memoised per schema object (`WeakMap`) — a controller file with 40 routes
 * converts each distinct schema once, not once per decorator evaluation.
 *
 * Best-effort on transforms: `zod-to-json-schema` documents the INPUT side of a `ZodEffects`
 * (a `.transform()` has no JSON-Schema output side to read). For a response schema that is
 * correct as long as response schemas are plain objects/arrays — which is what they should be.
 */
import type { SchemaObject } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// `zodToJsonSchema`'s own generic signature recurses through Zod's types and trips the compiler
// ("excessively deep") on arbitrary schemas; the call is deliberately typed at the boundary.
const convert = zodToJsonSchema as unknown as (
  schema: unknown,
  options: Record<string, unknown>,
) => Record<string, unknown>;

export type OpenApiSchemaMode = 'input' | 'output';

const cache: Record<OpenApiSchemaMode, WeakMap<ZodTypeAny, SchemaObject>> = {
  input: new WeakMap(),
  output: new WeakMap(),
};

export function zodToOpenApiSchema(
  schema: ZodTypeAny,
  mode: OpenApiSchemaMode = 'output',
): SchemaObject {
  const cached = cache[mode].get(schema);
  if (cached !== undefined) return cached;
  const converted = convert(schema, {
    target: 'openApi3',
    $refStrategy: 'none', // inline: no dangling $refs in a hand-assembled `schema:` object
    effectStrategy: 'input',
    pipeStrategy: mode,
  });
  delete converted.$schema;
  const result = converted as SchemaObject;
  cache[mode].set(schema, result);
  return result;
}
