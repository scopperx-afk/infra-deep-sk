/**
 * `@ListQuery()` — one declaration for a list endpoint's whole query contract (E-A9).
 *
 * Declaring a list endpoint the spec's way takes up to FOUR independent annotations that must
 * agree with each other (`@Filterable`, `@Sortable`, pagination docs, per-parameter `@ApiQuery`s).
 * They drift: someone adds a filter and forgets the docs, or documents a sort the parser ignores.
 * `@ListQuery()` derives BOTH the runtime allowlists and the OpenAPI parameters from ONE option
 * object, so the document cannot describe a filter the parser would not honour.
 *
 *   @ListQuery({
 *     pagination: 'cursor',
 *     filters: ['status', { name: 'createdAt', type: 'date' }],
 *     sorts: ['createdAt', 'email'],
 *   })
 *   @Get() list(@CursorParams() page, @Filters() filters, @Sorts() sorts) { ... }
 */
import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { compileFilterAllowlist } from '../filtering/filter-allowlist';
import { FILTERABLE_KEY } from '../filtering/filter-allowlist.decorator';
import type { FilterFieldType, FilterOperator, FilterableField } from '../filtering/filter.port';
import { ApiCursorPagination, ApiOffsetPagination } from '../openapi/api-zod.decorators';
import { Sortable } from '../sorting/sort-allowlist.decorator';

export interface ListQueryOptions {
  /** `'cursor'` (default, §5.1), `'offset'` (§5.2 — internal/admin only), or `false` for none. */
  readonly pagination?: 'cursor' | 'offset' | false;
  readonly filters?: readonly (string | FilterableField)[];
  readonly sorts?: readonly string[];
}

const BASE_SCHEMA: Readonly<Record<FilterFieldType, SchemaObject>> = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date-time' },
};

const OPERATOR_TEXT: Readonly<Record<FilterOperator, string>> = {
  eq: 'equals',
  ne: 'does not equal',
  gt: 'greater than',
  gte: 'greater than or equal to',
  lt: 'less than',
  lte: 'less than or equal to',
  in: 'any of (comma-separated)',
  like: 'contains (case handling is up to the endpoint)',
};

export const ListQuery = (options: ListQueryOptions = {}) => {
  const decorators: Array<ClassDecorator | MethodDecorator | PropertyDecorator> = [];

  const pagination = options.pagination ?? 'cursor';
  if (pagination === 'cursor') decorators.push(ApiCursorPagination());
  if (pagination === 'offset') decorators.push(ApiOffsetPagination());

  if (options.filters !== undefined && options.filters.length > 0) {
    const compiled = compileFilterAllowlist(options.filters);
    decorators.push(SetMetadata(FILTERABLE_KEY, compiled));
    for (const [key, { field, operator }] of compiled.keys) {
      decorators.push(
        ApiQuery({
          name: key,
          required: false,
          schema: operator === 'in' ? { type: 'string' } : BASE_SCHEMA[field.type],
          description: `Filter \`${field.name}\` ${OPERATOR_TEXT[operator]}.`,
        }),
      );
    }
  }

  if (options.sorts !== undefined && options.sorts.length > 0) {
    decorators.push(Sortable(options.sorts));
    decorators.push(
      ApiQuery({
        name: 'sort',
        required: false,
        // `example` MUST live inside `schema`: when a `schema` is given, @nestjs/swagger silently
        // drops a top-level `example` (verified against the generated document in openapi.spec.ts).
        schema: { type: 'string', example: `${options.sorts[0]}:desc` },
        description: `Comma-separated \`field[:asc|:desc]\`. Sortable: ${options.sorts.join(', ')}.`,
      }),
    );
  }

  return applyDecorators(...decorators);
};
