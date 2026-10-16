/**
 * `KEY_FILE` convention — Config spec §5.2.
 *
 * Multiline secrets (PEM keys, …) are delivered ONLY as
 * `NOTIFICATIONS__APNS__KEY_REF_FILE=/path/to/key.pem`; the loader reads the
 * file's contents as the value of `NOTIFICATIONS__APNS__KEY_REF`. There is
 * deliberately no second "literal \n gets unescaped" path.
 *
 * Provenance follows the RESOLVED FILE PATH: outside the project's working tree
 * (`/var/run/secrets/...`, an orchestrator-mounted volume) counts as
 * `process.env`-equivalent; inside the repo tree it counts as `committed-file`
 * and is subject to the same production guard as any committed literal (§9.2).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RawValueWithProvenance } from './config-source.port';

const FILE_SUFFIX = '_FILE';

/**
 * Only names following the `MODULE__KEY` convention are expanded. Unrelated
 * process-env variables that merely end in `_FILE` (`SSL_CERT_FILE`, …) must
 * never be read — an unreadable one would otherwise abort boot for no reason.
 */
export const isFileReferenceName = (name: string): boolean =>
  name.endsWith(FILE_SUFFIX) &&
  name.length > FILE_SUFFIX.length &&
  name.includes('__');

async function realOrLexical(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

const isInside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export async function expandFileReferences(
  entries: Record<string, RawValueWithProvenance>,
  cwd: string,
): Promise<Record<string, RawValueWithProvenance>> {
  const out: Record<string, RawValueWithProvenance> = {};
  const refs: Array<[string, RawValueWithProvenance]> = [];
  const problems: string[] = [];

  for (const [key, raw] of Object.entries(entries)) {
    if (isFileReferenceName(key)) refs.push([key, raw]);
    else out[key] = raw;
  }

  const root = await realOrLexical(cwd);
  for (const [key, raw] of refs) {
    const base = key.slice(0, -FILE_SUFFIX.length);
    if (base in entries) {
      problems.push(
        `${base} and ${key} are both set — use exactly one (the _FILE form is for multiline secrets only)`,
      );
      continue;
    }
    const abs = path.resolve(cwd, raw.value.trim());
    try {
      const content = await fs.readFile(abs, 'utf8');
      const resolved = await realOrLexical(abs);
      out[base] = {
        value: content, // never trimmed: a PEM's exact bytes matter, and this is a secret path (§5.1)
        origin: isInside(root, resolved) ? 'committed-file' : 'process.env',
        viaFile: true,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
      problems.push(`${key}: cannot read "${abs}" (${code})`); // path only — never file contents
    }
  }

  if (problems.length > 0) throw new Error(problems.join('; '));
  return out;
}
