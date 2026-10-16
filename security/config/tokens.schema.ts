/**
 * `tokens.*` — Security spec §5.1, §23 (Config spec §13.7).
 *
 * ── SPEC-ERRATA E-S6 ─────────────────────────────────────────────────────────────────
 * Config owns the DEFINITION of this namespace (§13.7), but Config itself only registers
 * `app` (config/index.ts: "every other namespace is registered by its own module via
 * forFeature()"), and no Authentication module exists yet to be that module — so without
 * a registrant `config.get('tokens.profiles')` would throw ConfigMissingError on the very
 * first request. Security, the only module that READS `tokens.*` today (interim JWT
 * verification, §5.1), registers it. When Authentication ships it takes the registration
 * over: the schema below is its contract (issuance reads the same profiles).
 *
 * `profiles[].secretRef` is the HS256 verification key — a literal secret today, a
 * `vault://` reference once a SecretResolver is provided; either way Config hands this
 * namespace the RESOLVED value, which is why the schema just requires a strong string.
 * `refreshSecretRef` is a DIFFERENT secret: a refresh token must never verify as an
 * access token (cross-purpose token confusion), so every secret across all profiles must
 * be pairwise distinct.
 */
import { z } from 'zod';
import { durationSchema } from '../../config';
import { jsonArray } from './schema-helpers';

/** HS256 wants a key at least as long as the hash output (RFC 7518 §3.2): 32 bytes. */
export const MIN_SECRET_LENGTH = 32;

export const tokenProfileSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'profile name must start with a letter and contain only letters, digits, "_" or "-"'),
  secretRef: z.string().min(MIN_SECRET_LENGTH, `secretRef must be at least ${MIN_SECRET_LENGTH} characters (HS256)`),
  refreshSecretRef: z.string().min(MIN_SECRET_LENGTH).optional(),
  issuer: z.string().min(1).optional(),
  audience: z.string().min(1).optional(),
  /** Seconds (Config's durationSchema: "900s" → 900). */
  accessTtl: durationSchema.optional(),
  refreshTtl: durationSchema.optional(),
});

export const tokensConfigSchema = z
  .object({
    profiles: jsonArray(tokenProfileSchema),
  })
  .superRefine((value, ctx) => {
    if (value.profiles.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profiles'],
        message: 'tokens.profiles must define at least one profile — with none, every authenticated request is rejected',
      });
    }
    const names = new Set<string>();
    const secrets = new Map<string, string>();
    value.profiles.forEach((profile, index) => {
      if (names.has(profile.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', index, 'name'], message: `duplicate profile name "${profile.name}"` });
      }
      names.add(profile.name);
      const entries: Array<['secretRef' | 'refreshSecretRef', string | undefined]> = [
        ['secretRef', profile.secretRef],
        ['refreshSecretRef', profile.refreshSecretRef],
      ];
      for (const [field, secret] of entries) {
        if (secret === undefined) continue;
        const where = `${profile.name}.${field}`;
        const previous = secrets.get(secret);
        if (previous !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['profiles', index, field],
            message: `${where} reuses the secret of ${previous} — every access/refresh secret must be distinct (a refresh token must never verify as an access token)`,
          });
        }
        secrets.set(secret, where);
      }
    });
  });

export type TokensConfig = z.infer<typeof tokensConfigSchema>;

/** Config paths (relative to the `tokens` namespace) that hold secret values — RegisterOptions.secretPaths. */
export const TOKENS_SECRET_PATHS: string[] = ['profiles[].secretRef', 'profiles[].refreshSecretRef'];
