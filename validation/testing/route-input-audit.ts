/**
 * Route-input audit — finds handler parameters that reach the application UNVALIDATED.
 *
 * `ZodValidationPipe` validates a parameter only when its declared type is a `createZodDto()` class
 * (§4's deliberately narrow scope). The flip side, verified: `@Body() body: SomeInterface` or
 * `@Body() body: SomeClass` is accepted — every field, every type, every extra key — with NO warning of any
 * kind. A forgotten `createZodDto()` is therefore invisible in review, in tests, and in production.
 *
 * This audit makes it visible. It is a TEST/CI tool (like `tracing/testing/`, `config/testing/`): call it
 * from one e2e/unit test over the real application graph, and a handler that takes a `@Body()` or a
 * whole-object `@Query()`/`@Param()` that is not a Zod DTO fails the build:
 *
 * ```ts
 * const app = await Test.createTestingModule({ imports: [AppModule] }).compile();
 * assertRouteInputsValidated(app);          // throws, listing every offender
 * ```
 *
 * A parameter counts as handled when its declared type IS a Zod DTO, or when the parameter carries its OWN
 * pipe (`@Body(new ParseArrayPipe(...))`, `@Param('id', ParseUUIDPipe)`) — that is an explicit decision by
 * the author. Named primitives (`@Param('id') id: string`) are only reported with `includeNamedPrimitives`.
 *
 * It reads Nest's own route metadata; it never calls a handler, never starts a server and never logs.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { ZodDto } from '../dto/create-zod-dto';

// Nest's metadata keys and `RouteParamtypes` values. Pinned to Nest's own constants by a unit test
// (importing `@nestjs/common/constants` here would be a deep import into framework internals).
const ROUTE_ARGS_METADATA = '__routeArguments__';
const PATH_METADATA = 'path';
const DESIGN_PARAM_TYPES = 'design:paramtypes';
const BODY = 3;
const QUERY = 4;
const PARAM = 5;

const KIND_NAMES: Readonly<Record<number, 'body' | 'query' | 'param'>> = { [BODY]: 'body', [QUERY]: 'query', [PARAM]: 'param' };

export interface UnvalidatedRouteInput {
  controller: string;
  handler: string;
  /** Position of the parameter in the handler's signature. */
  index: number;
  source: 'body' | 'query' | 'param';
  /** `@Query('page')` / `@Param('id')` → the selected key; whole-object parameters have none. */
  key?: string;
  /** The parameter's declared type as Nest sees it (`Object` for an interface). */
  declaredType: string;
}

export interface RouteInputAuditOptions {
  /** Also report named primitive selectors such as `@Param('id') id: string`. Default false. */
  includeNamedPrimitives?: boolean;
  /** Return true to accept a specific finding on purpose (a webhook that verifies a signature, a raw upload). */
  ignore?: (finding: UnvalidatedRouteInput) => boolean;
}

interface ParamMetadata {
  index: number;
  data?: unknown;
  pipes?: unknown[];
}

const isZodDtoClass = (type: unknown): boolean =>
  typeof type === 'function' && (type as Partial<ZodDto>).isZodDto === true;

function methodNames(proto: object): string[] {
  const names = new Set<string>();
  for (let p: object | null = proto; p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null)
    for (const n of Object.getOwnPropertyNames(p)) if (n !== 'constructor') names.add(n);
  return [...names];
}

export function findUnvalidatedRouteInputs(
  app: INestApplicationContext,
  options: RouteInputAuditOptions = {},
): UnvalidatedRouteInput[] {
  const findings: UnvalidatedRouteInput[] = [];
  const modules = app.get(ModulesContainer, { strict: false });

  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (typeof controller !== 'function') continue;
      const proto = controller.prototype as Record<string, unknown>;

      for (const name of methodNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue; // not a route
        const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) as Record<string, ParamMetadata> | undefined;
        if (!args) continue;
        const types = (Reflect.getMetadata(DESIGN_PARAM_TYPES, proto, name) as unknown[] | undefined) ?? [];

        for (const [slot, meta] of Object.entries(args)) {
          const source = KIND_NAMES[Number(slot.split(':')[0])];
          if (source === undefined) continue; // @Req/@Res/@Headers/@Ip/custom decorators — not a validation surface
          const declared = types[meta.index];
          const named = typeof meta.data === 'string' && meta.data.length > 0;
          const ownPipe = Array.isArray(meta.pipes) && meta.pipes.length > 0;
          if (isZodDtoClass(declared) || ownPipe) continue;
          if (named && !options.includeNamedPrimitives) continue;
          const finding: UnvalidatedRouteInput = {
            controller: controller.name,
            handler: name,
            index: meta.index,
            source,
            ...(named ? { key: meta.data as string } : {}),
            declaredType: typeof declared === 'function' ? declared.name || 'anonymous' : 'unknown',
          };
          if (!options.ignore?.(finding)) findings.push(finding);
        }
      }
    }
  }
  return findings.sort((a, b) => `${a.controller}.${a.handler}.${a.index}`.localeCompare(`${b.controller}.${b.handler}.${b.index}`));
}

/** Throws one Error listing every offender — the shape a CI failure should have. */
export function assertRouteInputsValidated(app: INestApplicationContext, options: RouteInputAuditOptions = {}): void {
  const findings = findUnvalidatedRouteInputs(app, options);
  if (findings.length === 0) return;
  const lines = findings.map(
    (f) =>
      `  ${f.controller}.${f.handler}() parameter #${f.index} @${f.source[0].toUpperCase()}${f.source.slice(1)}(${f.key ? `'${f.key}'` : ''}) is typed ${f.declaredType} — not a createZodDto() class`,
  );
  throw new Error(`${findings.length} route input(s) reach the application unvalidated:\n${lines.join('\n')}`);
}
