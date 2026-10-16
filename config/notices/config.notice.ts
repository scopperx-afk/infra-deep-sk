/**
 * onNotice dispatch + process.stderr fallback — Config spec §3.3, §10.2, §17.1.
 *
 * Config has NO dependency on Logger (Logger needs Config for its own settings —
 * §17.1). The application hands us an optional callback, wired to the real Logger
 * after Logger exists. Without one, a structured line goes to process.stderr — the
 * same fallback used for Config's own fatal bootstrap errors (§2).
 */
import type { ConfigNotice } from '../config.port';

export class ConfigNotifier {
  constructor(private readonly onNotice?: (notice: ConfigNotice) => void) {}

  notify(notice: ConfigNotice): void {
    if (this.onNotice) {
      try {
        this.onNotice(notice);
        return;
      } catch (err) {
        // A broken sink must never break configuration; fall through to stderr.
        this.stderr({
          level: 'error',
          code: 'notice-sink-failed',
          message: `onNotice callback threw: ${(err as Error).message}`,
        });
      }
    }
    this.stderr(notice);
  }

  /** Raw line for fatal bootstrap output (used by the initializer's one failure path). */
  writeFatal(text: string): void {
    process.stderr.write(`${text}\n`);
  }

  private stderr(notice: ConfigNotice): void {
    process.stderr.write(
      `${JSON.stringify({ module: 'config', ...notice })}\n`,
    );
  }
}
