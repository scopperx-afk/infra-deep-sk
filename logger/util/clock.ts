/** The single place Logger reads the system clock (Config's own architecture rule 20,
 *  applied consistently here too). */
export const nowIso = (): string => new Date().toISOString();

/** A `Date` for the current instant — the one other place a `Date` is constructed (calendar
 *  rotation in the File transport needs a real `Date`, not an ISO string). Keeping it here
 *  keeps boundary.spec's "new Date() only in clock.ts / emergency-logger.ts" rule true. */
export const nowDate = (): Date => new Date();
