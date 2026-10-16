/**
 * `@Filterable()` + `@Filters()` — API Infrastructure spec §6.2.
 *
 * The allowlist is MANDATORY: an endpoint with no `@Filterable()` declaration is filtered to
 * zero fields. A silent allow-all default would let any query parameter reach a repository's
 * `where` clause unvalidated.
 *
 * Deviation E-A4: §6.2's own usage example calls `@Filterable(['status', 'createdAt', {...}])`
 * with ONE ARRAY argument, while its declared signature is the rest-parameter
 * `(...fields: (string | FilterableField)[])`. Both are accepted here. The string shorthand means
 * a `string` field; anything else (numbers, dates, booleans, operator restrictions) takes the
 * object form.
 *
 * `@Filters()` is the parameter-side counterpart (E-A9): it reads the allowlist the handler (or its
 * controller) declared and returns `ParsedFilter[]` for the current request — so the allowlist and
 * its use cannot drift apart across two `Reflector` calls in handler code.
 */
import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { compileFilterAllowlist, type CompiledFilterAllowlist } from './filter-allowlist';
import { parseFilters } from './parse-filter';
import type { FilterableField, ParsedFilter } from './filter.port';

export const FILTERABLE_KEY = 'api:filterable';

type FilterableInput = string | FilterableField;

export const Filterable = (
  ...fields: Array<FilterableInput | readonly FilterableInput[]>
) => SetMetadata(FILTERABLE_KEY, compileFilterAllowlist(fields.flat()));

const reflector = new Reflector();

export function readFilterAllowlist(ctx: ExecutionContext): CompiledFilterAllowlist | undefined {
  return reflector.getAllAndOverride<CompiledFilterAllowlist | undefined>(FILTERABLE_KEY, [
    ctx.getHandler(),
    ctx.getClass(),
  ]);
}

export const Filters = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ParsedFilter[] => {
    const allowlist = readFilterAllowlist(ctx);
    if (allowlist === undefined) return []; // §6.2: no declaration → no filters
    return parseFilters(ctx.switchToHttp().getRequest<{ query?: unknown }>().query, allowlist);
  },
);
