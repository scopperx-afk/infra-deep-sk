/**
 * DotenvConfigSource — Config spec §5.2, §5.6. `critical: true`.
 *
 * ── Hard requirement (§5.2, checked by the boundary test) ──────────────────────
 * Files are parsed with `dotenv.parse()` (returns a plain object, touches nothing
 * else) and NEVER with `dotenv.config()`, which mutates `process.env`. If a
 * `.env` value were merged into `process.env` before EnvironmentConfigSource read
 * it, it would be re-tagged origin `process.env` and silently defeat the
 * production secret guard (§9.2).
 *
 * ── Files, lowest → highest precedence ─────────────────────────────────────────
 *   .env                         committed, dev-only shared defaults
 *   .env.{NODE_ENV}              committed per-environment overrides
 *   .env.local                   gitignored, origin `local-file`
 *   .env.{NODE_ENV}.local        gitignored, origin `local-file`
 * (§5.7 fixes the committed tiers; where `.local` files slot in is not stated
 * there, so this follows the usual convention: local beats committed.)
 * A MISSING file is normal (production containers usually have none); an
 * unreadable one (EACCES, EISDIR, …) is a fatal misconfiguration of a critical source.
 *
 * ── Parsing note (spec §5.2, "inline comments are not supported") ──────────────
 * dotenv ≥ 15 silently DROPS everything from the first `#` of an unquoted value —
 * a password or URL fragment gets truncated with no error. Rather than depend on the
 * installed dotenv version, such lines are REJECTED (dotenv-lint.ts): quote the value
 * or move the comment to its own line. This is stricter than the spec's letter (which
 * would keep `# comment` inside the value) but serves its stated purpose — no silent
 * surprise — see SPEC-ERRATA.md E-5.
 *
 * ── Hot-reload MVP (§5.6) ──────────────────────────────────────────────────────
 * `watch()` is the actual hot-reload mechanism until RemoteConfigSource exists. It
 * is gated to development/test by `watchEnvironments`, enforced by the hot-reload
 * manager against the validated `app.env`.
 */
import { promises as fs, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { nowMs } from '../util/clock';
import type {
  ConfigSource,
  ConfigValueOrigin,
  RawValueWithProvenance,
  SourceHealth,
  Unsubscribe,
} from './config-source.port';
import {
  describeAmbiguousHashes,
  findAmbiguousInlineComments,
} from './dotenv-lint';
import { expandFileReferences } from './file-reference';

export interface DotenvSourceOptions {
  /** Directory holding the `.env*` files. Default: process.cwd(). */
  cwd?: string;
  /** Overrides NODE_ENV for choosing `.env.{NODE_ENV}` (tests). */
  nodeEnv?: string;
  /** Debounce for the dev-only file watch. Default 50ms (editors write twice). */
  debounceMs?: number;
}

const SAFE_ENV_FILE_SUFFIX = /^[A-Za-z0-9_-]+$/;

export class DotenvConfigSource implements ConfigSource {
  readonly name = 'dotenv';
  readonly critical = true;
  readonly watchEnvironments = ['development', 'test'] as const;

  private readonly cwd: string;
  private lastValues: Record<string, string> = {};
  private lastLatencyMs: number | undefined;
  private lastError: string | undefined;
  private watchError: string | undefined;

  constructor(private readonly options: DotenvSourceOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
  }

  async load(): Promise<Record<string, RawValueWithProvenance>> {
    const started = nowMs();
    try {
      const result = await this.readAll();
      this.lastValues = Object.fromEntries(
        Object.entries(result).map(([k, v]) => [k, v.value]),
      );
      this.lastError = undefined;
      return result;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    } finally {
      this.lastLatencyMs = nowMs() - started;
    }
  }

  watch(
    callback: (updates: Record<string, RawValueWithProvenance>) => void,
  ): Unsubscribe {
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    let watcher: FSWatcher | undefined;

    const reload = async (): Promise<void> => {
      try {
        const fresh = await this.readAll();
        const changed: Record<string, RawValueWithProvenance> = {};
        for (const [key, raw] of Object.entries(fresh)) {
          if (this.lastValues[key] !== raw.value) changed[key] = raw;
        }
        // Removed keys are intentionally not reported: "reverting to the schema
        // default" has no RawValue representation. Restart to drop a key.
        this.lastValues = Object.fromEntries(
          Object.entries(fresh).map(([k, v]) => [k, v.value]),
        );
        this.watchError = undefined;
        if (!closed && Object.keys(changed).length > 0) callback(changed);
      } catch (err) {
        this.watchError = `dotenv watch reload failed: ${(err as Error).message}`;
      }
    };

    try {
      // Watch the directory, not the files: editors replace files (rename), which
      // kills a per-file watcher, and `.local` files may not exist yet.
      watcher = fsWatch(this.cwd, { persistent: false }, (_event, filename) => {
        if (filename && !String(filename).startsWith('.env')) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void reload(), this.options.debounceMs ?? 50);
        timer.unref?.();
      });
      watcher.on('error', (err) => {
        this.watchError = `dotenv watch connection lost: ${err.message}`;
      });
    } catch (err) {
      this.watchError = `dotenv watch could not start: ${(err as Error).message}`;
    }

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    };
  }

  async health(): Promise<SourceHealth> {
    const message = this.lastError ?? this.watchError;
    return {
      healthy: message === undefined,
      critical: this.critical,
      latencyMs: this.lastLatencyMs,
      message,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async readAll(): Promise<Record<string, RawValueWithProvenance>> {
    const base = await this.readParsed('.env');
    const nodeEnv =
      this.options.nodeEnv ?? process.env.NODE_ENV ?? base?.NODE_ENV;
    const envSuffix =
      nodeEnv && SAFE_ENV_FILE_SUFFIX.test(nodeEnv) ? nodeEnv : undefined;

    const layers: Array<{
      parsed: Record<string, string> | null;
      origin: ConfigValueOrigin;
    }> = [
      { parsed: base, origin: 'committed-file' },
      {
        parsed: envSuffix ? await this.readParsed(`.env.${envSuffix}`) : null,
        origin: 'committed-file',
      },
      { parsed: await this.readParsed('.env.local'), origin: 'local-file' },
      {
        parsed: envSuffix
          ? await this.readParsed(`.env.${envSuffix}.local`)
          : null,
        origin: 'local-file',
      },
    ];

    const merged: Record<string, RawValueWithProvenance> = {};
    for (const { parsed, origin } of layers) {
      if (!parsed) continue;
      for (const [key, value] of Object.entries(parsed))
        merged[key] = { value, origin };
    }
    return expandFileReferences(merged, this.cwd);
  }

  /** null = file absent (fine). Any other read failure throws → fatal for a critical source. */
  private async readParsed(
    fileName: string,
  ): Promise<Record<string, string> | null> {
    const file = path.join(this.cwd, fileName);
    let buf: Buffer;
    try {
      buf = await fs.readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(
        `cannot read ${fileName} (${(err as NodeJS.ErrnoException).code ?? 'unknown error'})`,
      );
    }
    const ambiguous = findAmbiguousInlineComments(buf.toString('utf8'));
    if (ambiguous.length > 0)
      throw new Error(describeAmbiguousHashes(fileName, ambiguous));
    return parseDotenv(buf); // never dotenv.config() — see header
  }
}
