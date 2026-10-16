/**
 * Validation error formatting — Config spec §7.9, §11.5.
 *
 * Errors are shown by ENVIRONMENT VARIABLE NAME (the person fixing the problem opens
 * `.env`, not the schema source), and redaction is unconditional: a path listed in a
 * namespace's `secretPaths` never has its received value rendered, regardless of
 * whether the underlying Zod issue or a thrown message happened to include it.
 */
import type { ZodIssue } from 'zod';
import type { ConfigRegistryImpl } from '../schema/registry';
import { scrub } from '../schema/secret-paths';
import type { MergedEntry } from '../store/config.store';
import { pathToEnvName } from '../util/env-name';

const MAX_SHOWN = 60;
const shorten = (s: string): string =>
  s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}…` : s;

const SAFE_SECRET_MESSAGES: Record<string, string> = {
  too_small: 'value is too short',
  too_big: 'value is too long',
  invalid_string: 'value has an invalid format',
  invalid_type: 'value has an invalid type',
  custom: 'value is invalid',
};

export function formatZodIssues(args: {
  namespace: string;
  issues: readonly ZodIssue[];
  registry: ConfigRegistryImpl;
  merged: ReadonlyMap<string, MergedEntry>;
  /** Every known secret value, for the final belt-and-braces scrub. */
  secretValues: readonly string[];
}): string[] {
  const { namespace, issues, registry, merged, secretValues } = args;
  return issues.map((issue) => {
    const envName = pathToEnvName([namespace, ...issue.path]);
    const isSecret = registry.isSecretIssuePath(namespace, issue.path);
    const hasIndex = issue.path.some((p) => typeof p === 'number');
    const raw = hasIndex
      ? undefined
      : merged.get([namespace, ...issue.path].join('.'));

    let text: string;
    if (issue.code === 'invalid_type' && issue.received === 'undefined') {
      text = 'required (env var not set)';
    } else if (isSecret) {
      // Never reuse Zod's own message here: enum/literal messages embed the received value.
      text = `${SAFE_SECRET_MESSAGES[issue.code] ?? 'value is invalid'} (received [REDACTED])`;
    } else if (issue.code === 'invalid_type' && raw) {
      const hint =
        issue.expected === 'number' || issue.expected === 'boolean'
          ? ' (env vars are always strings — check for stray quotes)'
          : '';
      text = `expected ${issue.expected}, received string "${shorten(raw.value)}"${hint}`;
    } else {
      text = issue.message.startsWith(`${envName}: `)
        ? issue.message.slice(envName.length + 2)
        : issue.message;
    }
    return scrub(`${envName}: ${text}`, secretValues);
  });
}

/** The exact banner shape from §7.9 / §11.5. */
export function formatFailureBanner(errors: readonly string[]): string {
  return [
    '❌ ConfigModule — configuration errors detected:',
    ...errors.map((e) => `  • ${e}`),
    '',
    'Application startup aborted.',
  ].join('\n');
}
