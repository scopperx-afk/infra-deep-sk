/**
 * ConfigRegistry implementation.
 *
 * Owns: the duplicate-registration guard (§17.7), secretPaths bookkeeping (§7.5)
 * and cross-validation aggregation (§7.4).
 *
 * Registration ≠ dependency (§2): this class only ever receives a namespace
 * string, a Zod schema and callbacks handed to it. It never imports, discovers or
 * reflects over the registering modules (§17.6).
 */
import type { ZodType, ZodTypeAny, ZodTypeDef } from 'zod';
import {
  ConfigRegistrationError,
  type ConfigRegistry,
  type CrossValidationFn,
  type RegisterOptions,
} from '../config.port';
import { enumerateSchemaPaths } from './schema-paths';

export interface RegisteredNamespace {
  readonly name: string;
  readonly schema: ZodTypeAny;
  readonly options: RegisterOptions;
  readonly secretPatterns: readonly string[];
  /** Relative (to the namespace) dotted paths the schema declares — best effort, see schema-paths.ts. */
  readonly knownPaths: ReadonlySet<string>;
}

/** camelCase, single segment: env-var conversion (§5.1.1) can only ever produce this shape. */
const NAMESPACE_RE = /^[a-z][a-zA-Z0-9]*$/;
/** `a.b`, `profiles[].secretRef` — one `[]` marker allowed per segment. */
const SECRET_PATH_RE =
  /^[A-Za-z][A-Za-z0-9]*(\[\])?(\.[A-Za-z][A-Za-z0-9]*(\[\])?)*$/;

/** `['profiles', 0, 'secretRef']` → `profiles[].secretRef` (issue-path → secretPaths pattern form). */
export function normalizeIssuePath(
  segments: ReadonlyArray<string | number>,
): string {
  let out = '';
  for (const s of segments) {
    if (typeof s === 'number') out += '[]';
    else out += out ? `.${s}` : s;
  }
  return out;
}

export class ConfigRegistryImpl implements ConfigRegistry {
  private readonly namespaceMap = new Map<string, RegisteredNamespace>();
  private readonly crossValidationFns: CrossValidationFn[] = [];
  private readonly secretRawPaths = new Set<string>(); // `ns.pattern` for patterns WITHOUT `[]`
  private readonly secretContainerPaths = new Set<string>(); // raw key holding a JSON blob with secrets inside
  private isSealed = false;

  registerSchema<T>(
    namespace: string,
    schema: ZodType<T, ZodTypeDef, unknown>,
    options: RegisterOptions = {},
  ): void {
    this.assertOpen(`registerSchema('${namespace}')`);
    if (typeof namespace !== 'string' || !NAMESPACE_RE.test(namespace)) {
      throw new ConfigRegistrationError(
        `Invalid namespace "${String(namespace)}": must be a single camelCase segment (e.g. "database", "rateLimit") — ` +
          `env-var names convert to exactly that shape (§5.1.1).`,
      );
    }
    if (this.namespaceMap.has(namespace)) {
      throw new ConfigRegistrationError(
        `Namespace "${namespace}" is already registered. Duplicate registration is an error — no merge, no ` +
          `last-write-wins (§17.7). A genuinely new shape is a new namespace name.`,
      );
    }
    const secretPatterns = [...(options.secretPaths ?? [])];
    for (const p of secretPatterns) {
      if (!SECRET_PATH_RE.test(p)) {
        throw new ConfigRegistrationError(
          `Invalid secretPaths entry "${p}" for namespace "${namespace}": expected e.g. "url" or "profiles[].secretRef".`,
        );
      }
    }

    const knownPaths = enumerateSchemaPaths(schema as ZodTypeAny);
    this.namespaceMap.set(namespace, {
      name: namespace,
      schema: schema as ZodTypeAny,
      options,
      secretPatterns,
      knownPaths,
    });

    for (const p of secretPatterns) {
      const arrayAt = p.indexOf('[]');
      if (arrayAt === -1) this.secretRawPaths.add(`${namespace}.${p}`);
      else this.secretContainerPaths.add(`${namespace}.${p.slice(0, arrayAt)}`);
    }
  }

  registerCrossValidation(fn: CrossValidationFn): void {
    this.assertOpen('registerCrossValidation');
    if (typeof fn !== 'function') {
      throw new ConfigRegistrationError(
        'registerCrossValidation() expects a function.',
      );
    }
    this.crossValidationFns.push(fn);
  }

  // ── internal read side (used by the pipeline, ConfigService, hot-reload) ──

  /**
   * Called once the pipeline starts parsing: from this point a late registration
   * would silently be missing from validation, so it throws instead (see the
   * ordering note in config.initializer.ts).
   */
  seal(): void {
    this.isSealed = true;
  }
  get sealed(): boolean {
    return this.isSealed;
  }

  hasNamespace(name: string): boolean {
    return this.namespaceMap.has(name);
  }
  getNamespace(name: string): RegisteredNamespace | undefined {
    return this.namespaceMap.get(name);
  }
  namespaces(): string[] {
    return [...this.namespaceMap.keys()].sort();
  }
  all(): readonly RegisteredNamespace[] {
    return [...this.namespaceMap.values()];
  }
  crossValidations(): readonly CrossValidationFn[] {
    return this.crossValidationFns;
  }

  /** Exact secret leaf (`database.url`) — whitespace trimming is skipped for these (§5.1, §7.5). */
  isSecretRawPath(dotted: string): boolean {
    return this.secretRawPaths.has(dotted);
  }
  /** A secret leaf OR a raw key that holds a JSON blob containing secrets (`tokens.profiles`). */
  isSecretOrSecretContainer(dotted: string): boolean {
    return (
      this.secretRawPaths.has(dotted) || this.secretContainerPaths.has(dotted)
    );
  }

  /**
   * True if a Zod issue at `[...issuePath]` in `namespace` points at a secret (or at
   * a container of secrets) — conservative on purpose: redaction over disclosure.
   */
  isSecretIssuePath(
    namespace: string,
    issuePath: ReadonlyArray<string | number>,
  ): boolean {
    const ns = this.namespaceMap.get(namespace);
    if (!ns) return false;
    const norm = normalizeIssuePath(issuePath);
    if (norm === '') return false;
    return ns.secretPatterns.some(
      (pattern) =>
        pattern === norm ||
        pattern.startsWith(`${norm}.`) ||
        pattern.startsWith(`${norm}[]`),
    );
  }

  /** Was `path` declared by some registered schema (best effort — see schema-paths.ts)? */
  isKnownPath(path: string): boolean {
    const [nsName, ...rest] = path.split('.');
    const ns = this.namespaceMap.get(nsName);
    if (!ns) return false;
    if (rest.length === 0) return true;
    return ns.knownPaths.has(rest.join('.'));
  }

  private assertOpen(what: string): void {
    if (this.isSealed) {
      throw new ConfigRegistrationError(
        `${what} was called after configuration loading started. Schemas must be registered while the module graph is ` +
          `being built (ConfigModule.forFeature()), before Config validates — a late registration would be silently skipped.`,
      );
    }
  }
}
