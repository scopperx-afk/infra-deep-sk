/** Filtering types — API Infrastructure spec §6. */
export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'like';
export type FilterFieldType = 'string' | 'number' | 'boolean' | 'date';

export interface FilterableField {
  /** Field name as it appears in the query parameter (the part BEFORE any operator suffix). */
  readonly name: string;
  /** Type the parser coerces to. Default `'string'` (E-A4 — §6.2's own `@Filterable(['status', …])` shorthand needs one). */
  readonly type?: FilterFieldType;
  /** Operators permitted for this field; absent = every operator that makes sense for `type`. */
  readonly allowedOperators?: readonly FilterOperator[];
}

export interface ParsedFilter {
  readonly field: string;
  readonly operator: FilterOperator;
  /** Coerced to the field's declared type: `string`, `number`, `boolean`, a `Date`, or an array of those for `in`. */
  readonly value: unknown;
}
