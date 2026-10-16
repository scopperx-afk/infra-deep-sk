/**
 * `http.*` — registered by HTTP itself via `ConfigModule.forFeature()` (Config
 * spec §12: every module registers its own namespace).
 *
 * The `credentials=true` + wildcard-`origin` rejection (HTTP spec §5, Config
 * spec §7.3) is enforced HERE, inside this schema's own `.superRefine()` — it
 * is a same-namespace (`http.cors.*`) field-pairing rule, not a cross-NAMESPACE
 * one, so it doesn't need Config's `registerCrossValidation()` mechanism
 * (reserved for rules spanning two different namespaces, e.g. Logger's
 * `logging.*` cross-checks). Config's own spec describes this rule as an
 * EXAMPLE of what the mechanism enables; it does not pre-register it for a
 * namespace ('http') Config itself doesn't own — that responsibility belongs
 * to whichever module owns `http.*`, which is this file.
 */
import { z } from 'zod';
import { booleanSchema, csvArray, numberSchema } from '../../config';

export const httpConfigSchema = z.object({
  cors: z
    .object({
      origins: csvArray(z.string().url().or(z.literal('*'))),
      credentials: booleanSchema.default(false),
    })
    .superRefine((v, ctx) => {
      if (v.credentials && v.origins.includes('*')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['credentials'],
          message: 'http.cors.credentials cannot be true when http.cors.origins includes the wildcard "*" (§5, §7.3)',
        });
      }
    }),
  /** A byte-size string in the shape Express's own body-parser accepts natively ("1mb", "512kb") —
   *  passed straight through, never independently re-parsed (§6). */
  bodyLimit: z.string().min(1).default('1mb'),
  timeout: z.object({ requestMs: numberSchema.pipe(z.number().int().positive()).default(30000) }).default({}),
  correlationHeader: z.string().min(1).default('x-correlation-id'),
  /** Not in Config's own §13.2 catalog row list — see SPEC-ERRATA.md E-H2: HTTP spec §9 calls
   *  clientVersion's source "a project-defined header, e.g. X-Client-Version," which this schema
   *  takes literally by making the NAME itself configurable, the same way `correlationHeader` is. */
  clientVersionHeader: z.string().min(1).default('x-client-version'),
});

export type HttpConfig = z.infer<typeof httpConfigSchema>;
