/**
 * `@Sortable()` + `@Sorts()` — API Infrastructure spec §7.2.
 *
 * Same mandatory-allowlist rule as filtering: no declaration → no sortable fields → any `?sort=`
 * is ignored. Without it, `?sort=password_hash:asc` on a user list is an information-disclosure
 * oracle (the order of the results leaks the hash's ordering); the allowlist prevents it
 * structurally.
 *
 * Accepts rest arguments or one array (the same E-A4 tolerance `@Filterable()` has).
 */
import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isValidFieldName } from '../filtering/filter-allowlist';
import { parseSorts } from './parse-sort';
import type { ParsedSort } from './sort.port';

export const SORTABLE_KEY = 'api:sortable';

export const Sortable = (...fields: Array<string | readonly string[]>) => {
  const flat = fields.flat();
  const set = new Set<string>();
  for (const name of flat) {
    if (!isValidFieldName(name)) {
      throw new TypeError(`@Sortable: invalid field name ${JSON.stringify(name)}`);
    }
    if (set.has(name)) throw new TypeError(`@Sortable: field "${name}" is declared twice`);
    set.add(name);
  }
  return SetMetadata(SORTABLE_KEY, set as ReadonlySet<string>);
};

const reflector = new Reflector();

export function readSortAllowlist(ctx: ExecutionContext): ReadonlySet<string> | undefined {
  return reflector.getAllAndOverride<ReadonlySet<string> | undefined>(SORTABLE_KEY, [
    ctx.getHandler(),
    ctx.getClass(),
  ]);
}

export const Sorts = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ParsedSort[] => {
    const allowlist = readSortAllowlist(ctx);
    if (allowlist === undefined) return [];
    return parseSorts(ctx.switchToHttp().getRequest<{ query?: unknown }>().query, allowlist);
  },
);
