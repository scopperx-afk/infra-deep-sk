/** Sorting types — API Infrastructure spec §7. */
export type SortDirection = 'asc' | 'desc';

export interface ParsedSort {
  readonly field: string;
  readonly direction: SortDirection;
}
