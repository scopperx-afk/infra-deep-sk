/**
 * EmergencyLogger — Logger spec §27. The one thing this file must NEVER do is
 * depend on any other part of this module (not `ConsoleTransport`, not
 * `LogRedactor`, not even `logger.port.ts`'s types beyond a plain string
 * union) — if `LoggerService` itself is broken, this is what reports that.
 * Deliberately does not touch the main DI graph.
 *
 * No redaction, no size limits, no sampling: a raw `process.stderr.write`
 * wrapped in its own try/catch, because even `JSON.stringify` throwing (a
 * circular object, a BigInt) must not prevent SOME line reaching stderr.
 */

export function emergencyLog(message: string, error?: unknown): void {
  try {
    const payload: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: 'fatal',
      message,
    };
    if (error instanceof Error)
      payload.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    else if (error !== undefined) payload.error = String(error);
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Not even JSON.stringify is trusted here — this is the actual last resort.
    process.stderr.write(`FATAL: ${message}\n`);
  }
}
