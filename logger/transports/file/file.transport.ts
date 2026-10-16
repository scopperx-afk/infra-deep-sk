/**
 * File transport — Logger spec §20 (deferred in the original implementation;
 * built out here per §42's own "one at a time" plan — see SPEC-ERRATA.md
 * E-L9). NEVER the critical transport (§25's table hard-wires only Console —
 * logger.module.ts): a disk-full or permission error here must degrade, never
 * take the app down. Concretely, that means this transport's CONSTRUCTOR must
 * never throw either — it is built synchronously inside a DI factory
 * (logger.module.ts), where a throw would abort application bootstrap over a
 * transport that, by §25's own rule, isn't supposed to be load-bearing.
 *
 * Two independently-rotated files, both fed from the SAME entry:
 *  - `appPath` — every level that reaches this transport at all (the
 *    "everything" log).
 *  - `errorPath` — ERROR/FATAL only, duplicated alongside `appPath` — the
 *    same stdout/stderr split ConsoleTransport already makes (§19), just
 *    persisted to disk instead of routed to the two standard streams, so an
 *    operator can `tail -f` just the failures without grepping the combined
 *    log.
 *
 * Output is always ONE JSON object per line, regardless of `logging.format` —
 * there is no "pretty" file mode. `pino-pretty` (used by ConsoleTransport,
 * §19) is a terminal formatter; a file is read by `tail`/`jq`/a log shipper,
 * not a human scrolling a terminal, so the console's json/pretty distinction
 * doesn't apply here at all.
 *
 * ── Rotation, pruning, and why NOT the original numbered-shift scheme ───────
 * Rotation triggers on size (`maxSizeMb`) and, optionally, on a calendar
 * boundary (`datePattern: 'daily' | 'hourly'`, checked lazily on the next
 * write after the boundary — no background timer). Every rotated backup is
 * renamed to `${path}.<suffix>` (a timestamp, or a date/hour key for a
 * date-triggered rotation) and, when `compress` is on (the default), gzipped
 * and the uncompressed copy removed.
 *
 * Retention is enforced by PRUNING — list this file's own backups, sort by
 * mtime, delete everything past `maxFiles` — rather than the numbered
 * `path.1 → path.2 → …` shift-on-rotate scheme an earlier version of this
 * file used. Two reasons: (1) a shift loop has an off-by-one at `maxFiles = 1`
 * (the loop's own bound never runs, so nothing is ever renamed or deleted and
 * the file just grows unbounded — a real bug caught in review); a
 * count-then-delete prune has no equivalent edge case at any `maxFiles ≥ 1`.
 * (2) mixing size-triggered and date-triggered backups under one numbered
 * sequence has no natural ordering; mtime-based pruning treats both the same
 * way for free. (`logging.file.maxFiles` is additionally floored at 2 in the
 * schema — see logging.schema.ts — because "keep 0 backups" is really "don't
 * rotate," better spelled as `enabled: false`; the prune logic below is
 * correct even at `maxFiles = 1` regardless, as defense in depth.)
 *
 * Built on plain `node:fs`/`node:zlib`, not an external rotation package —
 * this module already builds its own small primitives rather than reaching
 * for a dependency when the primitive is this contained (compare
 * `backpressure/priority-buffer.ts`).
 */
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as zlib from 'node:zlib';
import type { LogEntry, LogLevel } from '../../logger.port';
import { nowDate } from '../../util/clock';
import type { LogTransport, TransportHealth } from '../transport.interface';

const ERROR_LEVELS: ReadonlySet<LogLevel> = new Set(['error', 'fatal']);

/** Minimum gap between attempts to re-open a stream that errored. */
const RECOVERY_INTERVAL_MS = 5_000;

export type FileDatePattern = 'none' | 'daily' | 'hourly';

export interface FileTransportOptions {
  appPath: string;
  errorPath: string;
  maxSizeBytes: number;
  maxFiles: number;
  compress: boolean;
  datePattern: FileDatePattern;
}

interface RotatingFileOptions {
  path: string;
  maxBytes: number;
  maxFiles: number;
  compress: boolean;
  datePattern: FileDatePattern;
}

/**
 * One rotated file, entirely self-contained. `TransportDispatcher` (§22/§23)
 * only ever has one `FileTransport.write()` in flight at a time — but a
 * single `write()` call here fans out to up to two `RotatingFile`s at once
 * (app + error, for an ERROR/FATAL entry), so each `RotatingFile` still needs
 * its OWN serial queue: without it, an error entry's app-file write and a
 * rotation triggered by a DIFFERENT error entry's error-file write could
 * interleave against the same file handle.
 */
class RotatingFile {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly compress: boolean;
  private readonly datePattern: FileDatePattern;

  private stream: fs.WriteStream | undefined;
  private size = 0;
  private currentPeriodKey: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private broken = false;
  private brokenAt = 0;

  constructor(options: RotatingFileOptions) {
    this.path = options.path;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.compress = options.compress;
    this.datePattern = options.datePattern;

    try {
      fs.mkdirSync(dirname(this.path), { recursive: true });
      this.size = fs.existsSync(this.path) ? fs.statSync(this.path).size : 0;
      this.stream = this.openStream();
      if (this.datePattern !== 'none')
        this.currentPeriodKey = this.periodKey(nowDate());
    } catch {
      // Constructor never throws (see file header) — write() below keeps failing
      // health() honestly instead of taking bootstrap down over a bad path.
      this.markBroken();
    }
  }

  private markBroken(): void {
    this.broken = true;
    this.brokenAt = Date.now();
  }

  private openStream(): fs.WriteStream {
    const stream = fs.createWriteStream(this.path, { flags: 'a' });
    stream.on('error', () => {
      this.markBroken();
    });
    return stream;
  }

  /** A single transient error (ENOSPC that gets cleaned up, a log directory that was briefly
   *  unmounted, a failed rotation) used to disable file logging until the process restarted.
   *  Re-open at most once per RECOVERY_INTERVAL_MS; a still-failing path simply stays broken. */
  private tryRecover(): void {
    if (!this.broken || Date.now() - this.brokenAt < RECOVERY_INTERVAL_MS) return;
    try {
      fs.mkdirSync(dirname(this.path), { recursive: true });
      this.size = fs.existsSync(this.path) ? fs.statSync(this.path).size : 0;
      this.stream?.destroy();
      this.stream = this.openStream();
      this.broken = false;
    } catch {
      this.brokenAt = Date.now(); // try again later
    }
  }

  /** Queues onto this file's own serial chain — a rotation in progress can
   *  never interleave with the write behind it. Never throws synchronously;
   *  a failure surfaces through the returned promise's rejection instead. */
  write(line: string): Promise<void> {
    const next = this.queue.then(() => this.doWrite(line));
    // Swallow here so one failed write doesn't poison every write queued
    // after it — each write's OWN outcome is still reported to its caller
    // via the (unswallowed) `next` promise returned below.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async doWrite(line: string): Promise<void> {
    this.tryRecover();
    if (this.broken || !this.stream)
      throw new Error(`file transport: '${this.path}' is unavailable`);

    if (this.datePattern !== 'none') {
      const key = this.periodKey(nowDate());
      if (
        this.currentPeriodKey !== undefined &&
        key !== this.currentPeriodKey
      ) {
        await this.rotate(this.currentPeriodKey);
      }
      this.currentPeriodKey = key;
    }

    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.size > 0 && this.size + bytes > this.maxBytes)
      await this.rotate(String(Date.now()));

    await this.append(line);
    this.size += bytes;
  }

  private append(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream!.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Renames the active file to `${path}.<suffix>`, optionally gzips it, opens
   *  a fresh stream on the original path, and prunes backups beyond
   *  `maxFiles`. `suffix` is the CLOSING period's key for a date rotation
   *  (so `app.log.2026-09-27`, not the day about to start) or a timestamp for
   *  a size rotation. */
  private async rotate(suffix: string): Promise<void> {
    await this.closeStream();
    try {
      if (fs.existsSync(this.path) && fs.statSync(this.path).size > 0) {
        const rotatedPath = `${this.path}.${suffix}`;
        fs.renameSync(this.path, rotatedPath);
        if (this.compress) await this.compressFile(rotatedPath);
      }
      await this.pruneOldBackups();
      this.size = 0;
    } finally {
      // Whatever happened above (rename EBUSY/EPERM, a failed prune) a fresh stream is ALWAYS
      // reopened: the old one has been `end()`ed, and leaving it in place meant every later
      // write failed with "write after end" and file logging died permanently.
      this.stream = this.openStream();
    }
  }

  private compressFile(filePath: string): Promise<void> {
    return new Promise((resolve) => {
      const gzPath = `${filePath}.gz`;
      const source = fs.createReadStream(filePath);
      const dest = fs.createWriteStream(gzPath);
      const finish = (): void => {
        // Best-effort: an uncompressed backup left behind on failure is still a
        // valid backup — compression is an optimization, never a correctness
        // requirement, so any error here just resolves rather than propagating.
        fs.unlink(filePath, () => resolve());
      };
      source.pipe(zlib.createGzip()).pipe(dest);
      dest.on('finish', finish);
      dest.on('error', () => resolve());
      source.on('error', () => resolve());
    });
  }

  /** Lists this file's own rotated backups (`${basename}.*`, compressed or
   *  not), sorted newest-first by mtime, and deletes everything past
   *  `maxFiles` — see this file's header for why pruning replaced the
   *  original numbered-shift scheme. */
  private async pruneOldBackups(): Promise<void> {
    const dir = dirname(this.path);
    const base = basename(this.path);
    let names: string[];
    try {
      names = fs
        .readdirSync(dir)
        .filter((f) => f !== base && f.startsWith(`${base}.`));
    } catch {
      return;
    }

    const withMtime = names
      .map((name) => {
        const full = join(dir, name);
        try {
          return { full, mtimeMs: fs.statSync(full).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter(
        (entry): entry is { full: string; mtimeMs: number } =>
          entry !== undefined,
      )
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const stale of withMtime.slice(this.maxFiles)) {
      try {
        fs.unlinkSync(stale.full);
      } catch {
        /* best-effort cleanup — a leftover backup file is not worth failing the write over */
      }
    }
  }

  private periodKey(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    if (this.datePattern === 'hourly')
      return `${y}-${m}-${d}-${String(date.getUTCHours()).padStart(2, '0')}`;
    return `${y}-${m}-${d}`;
  }

  private closeStream(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
    });
  }

  async close(): Promise<void> {
    await this.queue;
    await this.closeStream();
  }

  healthy(): boolean {
    return !this.broken;
  }
}

export class FileTransport implements LogTransport {
  readonly name = 'file';
  private readonly appFile: RotatingFile;
  private readonly errorFile: RotatingFile;
  private lastError: string | undefined;

  constructor(options: FileTransportOptions) {
    // Defense in depth: even if something constructs this transport directly
    // (bypassing logging.schema.ts's own `min(2)`), pruning below is correct
    // at any maxFiles ≥ 1 — this floor only guards against 0/negative values.
    const maxFiles = Math.max(1, options.maxFiles);
    this.appFile = new RotatingFile({
      path: options.appPath,
      maxBytes: options.maxSizeBytes,
      maxFiles,
      compress: options.compress,
      datePattern: options.datePattern,
    });
    this.errorFile = new RotatingFile({
      path: options.errorPath,
      maxBytes: options.maxSizeBytes,
      maxFiles,
      compress: options.compress,
      datePattern: options.datePattern,
    });
  }

  async write(entry: LogEntry): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch (err) {
      // A circular or otherwise unserializable field slipped past redaction/entry-building —
      // record it, but never let it crash the write call itself (§13's own "must never
      // prevent the log line from being written" principle, applied here too).
      this.lastError = (err as Error).message;
      return;
    }

    const writes = [this.appFile.write(line)];
    if (ERROR_LEVELS.has(entry.level)) writes.push(this.errorFile.write(line));

    try {
      await Promise.all(writes);
      this.lastError = undefined;
    } catch (err) {
      // Isolated here, exactly like ConsoleTransport — TransportDispatcher's own §23
      // isolation is a second, redundant safety net, not the only one.
      this.lastError = (err as Error).message;
    }
  }

  health(): TransportHealth {
    if (!this.appFile.healthy() || !this.errorFile.healthy()) {
      return {
        healthy: false,
        message: this.lastError ?? 'file stream unavailable',
      };
    }
    return this.lastError === undefined
      ? { healthy: true }
      : { healthy: false, message: this.lastError };
  }

  async close(): Promise<void> {
    await Promise.all([this.appFile.close(), this.errorFile.close()]);
  }
}
