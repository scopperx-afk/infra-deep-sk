/**
 * SecretResolver port — Config spec §5.5. Interface only: NO concrete adapter
 * ships until OPEN-05 (which secret manager) is answered, and then exactly one
 * (§15). Until then secrets arrive as literals through orchestrator-injected
 * process.env (§5.4).
 */
import type { SourceHealth } from '../sources/config-source.port';

export interface SecretResolver {
  readonly prefix: string; // e.g. "vault", "aws-secrets"
  resolve(reference: string): Promise<string>;
  health(): Promise<SourceHealth>;
}

/**
 * Reference schemes Config recognizes even when no resolver is registered, so an
 * unresolvable reference is a fail-fast error instead of a silent pass-through
 * (§9.2). Deliberately NOT a generic `scheme://` pattern — `postgres://…` is a
 * perfectly valid literal for `database.url`.
 */
export const KNOWN_SECRET_REFERENCE_SCHEMES: readonly string[] = [
  'vault',
  'aws-secrets',
];

/** Returns the scheme of a secret reference, or null if `value` is a plain literal. */
export function secretReferenceScheme(
  value: string,
  extraSchemes: readonly string[] = [],
): string | null {
  const m = /^([a-z][a-z0-9-]*):\/\//.exec(value);
  if (!m) return null;
  const scheme = m[1];
  return KNOWN_SECRET_REFERENCE_SCHEMES.includes(scheme) ||
    extraSchemes.includes(scheme)
    ? scheme
    : null;
}
