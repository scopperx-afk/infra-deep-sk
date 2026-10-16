/** The single place Config reads the system clock (architecture rule 20). */
export const nowIso = (): string => new Date().toISOString();
export const nowMs = (): number => performance.now();
