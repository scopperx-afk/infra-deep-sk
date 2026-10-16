/**
 * `api.*` — registered by API Infrastructure itself via `ConfigModule.forFeature()` (Config spec
 * §12: every module registers its own namespace; Config spec §13.20 carries the catalog entry).
 *
 * The seven keys of Config §13.20 are unchanged in name, type and default. This file adds the
 * validation §13.20 cannot express in a table, plus two keys the spec's own text implies but never
 * catalogued (Deviation E-A2/E-A13 — see `API_INFRASTRUCTURE_GUIDE.md`, "Config catalog addendum"):
 *
 *   • `pagination.maxPage`   — offset mode (§5.2) deep-page cap. `OFFSET 5_000_000` is a table
 *                              scan that even an admin endpoint should refuse.
 *   • `cursor.signingKeys`   — OPTIONAL HMAC keys (newest first) that make a cursor tamper-evident
 *                              (§5.1.3 left signing to "the domain"; a platform with millions of
 *                              users should not leave that to every domain team independently).
 *
 * Cross-field rule (same-namespace → `.superRefine()`, the HTTP schema's own precedent, not
 * Config's cross-NAMESPACE hook): `defaultLimit <= maxLimit`, otherwise an omitted `?limit=` would
 * itself be a request this module rejects.
 */
import { z } from 'zod';
import { booleanSchema, csvArray, numberSchema } from '../../config';
import {
  API_HARD_MAX_LIMIT,
  API_HARD_MAX_PAGE,
  MIN_CURSOR_KEY_LENGTH,
} from '../api-infrastructure.constants';

const boundedInt = (min: number, max: number) =>
  numberSchema.pipe(z.number().int().min(min).max(max));

export const apiConfigSchema = z.object({
  /** Default API version reported in `meta.apiVersion` when the URL path carries none (§8.2). */
  version: z
    .string()
    .regex(/^v\d+$/, 'expected an API version like "v1" (lowercase v + digits)')
    .default('v1'),
  pagination: z
    .object({
      defaultLimit: boundedInt(1, API_HARD_MAX_LIMIT).default(20),
      maxLimit: boundedInt(1, API_HARD_MAX_LIMIT).default(100),
      maxPage: boundedInt(1, API_HARD_MAX_PAGE).default(1_000),
    })
    .superRefine((p, ctx) => {
      if (p.defaultLimit > p.maxLimit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultLimit'],
          message: 'api.pagination.defaultLimit must be <= api.pagination.maxLimit',
        });
      }
    })
    .default({}),
  envelope: z
    .object({
      enabled: booleanSchema.default(true),
      includeTimestamp: booleanSchema.default(true),
      includeApiVersion: booleanSchema.default(true),
      includeCorrelationId: booleanSchema.default(true),
    })
    .default({}),
  cursor: z
    .object({
      /** Secret — declared via `secretPaths: ['cursor.signingKeys']` at registration (Config §7.5). */
      signingKeys: csvArray(
        z
          .string()
          .min(
            MIN_CURSOR_KEY_LENGTH,
            `each cursor signing key must be at least ${MIN_CURSOR_KEY_LENGTH} characters`,
          ),
      ).optional(),
    })
    .default({}),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
