/** The single place API Infrastructure reads the system clock (architecture rule 20) —
 *  the same convention Config's and Logger's own `util/clock.ts` already follow. */
export const nowIso = (): string => new Date().toISOString();
