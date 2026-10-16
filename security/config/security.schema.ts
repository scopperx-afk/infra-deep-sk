/**
 * `security.*` — Security spec §23. Registered by Security itself through
 * `ConfigModule.forFeature('security', …)` (Config spec §12: every module registers its own
 * namespace). Same-namespace field-pairing rules live in this schema's `.superRefine()`s
 * (the pattern HTTP's `http.schema.ts` documents); rules that need ANOTHER namespace
 * (`app.env`) live in `security.cross-validation.ts`.
 *
 * Nothing here is hot-reloadable (§23): a header policy / key ring that changes under a
 * running process is a hazard, not a feature.
 *
 * Secure by default: every default below is the restrictive choice; `.env.development`
 * relaxes (`HTTPS_ENFORCEMENT__ENABLED=false`, `COOKIES__DEFAULT_SECURE=false`) — never the
 * other way round.
 */
import { z } from 'zod';
import { booleanSchema, csvArray, numberSchema, portSchema } from '../../config';
import { KEY_ID_RE, decodeKeyMaterial } from '../crypto/key-ring';
import { isValidIpOrCidr, isValidTrustProxyEntry } from '../network/trusted-proxy.util';
import { optionalString, jsonArray } from './schema-helpers';

const intIn = (min: number, max: number) => numberSchema.pipe(z.number().int().min(min).max(max));

/** `false` | hop count | `true` | comma-separated IPs/CIDRs/presets — Express's own `trust proxy` vocabulary. */
const trustProxySchema = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    const s = v.trim();
    if (s === '' || s.toLowerCase() === 'false') return false;
    if (s.toLowerCase() === 'true') return true;
    if (/^\d+$/.test(s)) return Number(s);
    return s;
  },
  z.union([
    z.boolean(),
    z.number().int().min(0).max(32),
    z
      .string()
      .refine((s) => s.split(',').every((e) => isValidTrustProxyEntry(e)), {
        message: 'expected false, a hop count, or a comma-separated list of IPs/CIDRs/presets (loopback, linklocal, uniquelocal)',
      }),
  ]),
);

/** A CSP source expression: no whitespace, `;` or `,` — a `;` would let a value inject a whole new directive. */
const CSP_SOURCE_RE = /^[^\s;,\u0000-\u001F\u007F]+$/;
const cspSources = (defaultValue: string) =>
  csvArray(z.string().regex(CSP_SOURCE_RE, 'invalid CSP source expression')).default(defaultValue);

/** `host`, `*.host`, `host:port`, `[v6]` or `[v6]:port`. */
const HOST_ENTRY_RE = /^(?:(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

const HEADER_SAFE_RE = /^[\u0020-\u007E]*$/; // printable ASCII: no CR/LF/control → no response splitting via config

const HTTP_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export const securityConfigSchema = z.object({
  trustProxy: trustProxySchema.default(false),

  httpsEnforcement: z
    .object({
      enabled: booleanSchema.default(true),
      redirectStatus: numberSchema.pipe(z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])).default(308),
    })
    .default({}),

  hsts: z
    .object({
      maxAge: intIn(0, 63_072_000 * 5).default(63_072_000), // 2 years
      includeSubDomains: booleanSchema.default(true),
      preload: booleanSchema.default(false),
    })
    .default({})
    .superRefine((v, ctx) => {
      if (v.preload && (!v.includeSubDomains || v.maxAge < 31_536_000)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['preload'],
          message: 'security.hsts.preload requires includeSubDomains=true and maxAge >= 31536000 (the browser preload-list rules)',
        });
      }
    }),

  headers: z
    .object({
      frameOptions: z.enum(['DENY', 'SAMEORIGIN']).default('DENY'),
      referrerPolicy: z
        .enum([
          'no-referrer',
          'no-referrer-when-downgrade',
          'origin',
          'origin-when-cross-origin',
          'same-origin',
          'strict-origin',
          'strict-origin-when-cross-origin',
          'unsafe-url',
        ])
        .default('strict-origin-when-cross-origin'),
      permissionsPolicy: z
        .string()
        .regex(HEADER_SAFE_RE, 'must be printable ASCII')
        .default('camera=(), microphone=(), geolocation=(), payment=()'),
      coop: z.enum(['same-origin', 'same-origin-allow-popups', 'unsafe-none']).default('same-origin'),
      coep: z.enum(['require-corp', 'credentialless', 'unsafe-none']).default('require-corp'),
      corp: z.enum(['same-origin', 'same-site', 'cross-origin']).default('same-origin'),
      csp: z
        .object({
          enabled: booleanSchema.default(true),
          reportOnly: booleanSchema.default(false),
          reportUri: optionalString(z.string().url().regex(CSP_SOURCE_RE, 'must not contain whitespace, ";" or ","')),
          /** Adds a per-request `'nonce-…'` to script-src/style-src when those directives are set (§8.4). */
          useNonce: booleanSchema.default(false),
          upgradeInsecureRequests: booleanSchema.default(false),
          // Directive sources — an API's strictest default; widen per deployment.
          defaultSrc: cspSources("'none'"),
          scriptSrc: cspSources(''),
          styleSrc: cspSources(''),
          imgSrc: cspSources(''),
          fontSrc: cspSources(''),
          connectSrc: cspSources(''),
          frameSrc: cspSources(''),
          objectSrc: cspSources(''),
          baseUri: cspSources("'none'"),
          formAction: cspSources("'none'"),
          frameAncestors: cspSources("'none'"),
        })
        .default({}),
    })
    .default({}),

  cookies: z
    .object({
      defaultSameSite: z.enum(['lax', 'strict', 'none']).default('lax'),
      defaultSecure: booleanSchema.default(true),
    })
    .default({})
    .superRefine((v, ctx) => {
      if (v.defaultSameSite === 'none' && !v.defaultSecure) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultSecure'],
          message: 'SameSite=None cookies must be Secure — browsers reject them otherwise',
        });
      }
    }),

  csrf: z
    .object({
      enabled: booleanSchema.default(true),
      cookieName: z.string().regex(HTTP_TOKEN_RE, 'must be a valid cookie name').default('csrf-token'),
      headerName: z
        .string()
        .regex(HTTP_TOKEN_RE, 'must be a valid header name')
        .transform((s) => s.toLowerCase())
        .default('x-csrf-token'),
    })
    .default({}),

  injection: z
    .object({
      maxJsonDepth: intIn(1, 100).default(20),
      redosTimeoutMs: intIn(10, 5000).default(100),
      stripPrototypeKeys: booleanSchema.default(true),
    })
    .default({}),

  /** Empty = no Host restriction. Entries: `api.example.com`, `*.example.com`, `host:8080`. */
  allowedHosts: csvArray(z.string().regex(HOST_ENTRY_RE, 'expected a hostname (optionally "*." prefixed / ":port"), e.g. api.example.com')).default(''),

  ipPolicy: z
    .object({
      allowlist: csvArray(z.string().refine(isValidIpOrCidr, 'expected an IP address or CIDR')).default(''),
      blocklist: csvArray(z.string().refine(isValidIpOrCidr, 'expected an IP address or CIDR')).default(''),
    })
    .default({}),

  clamav: z
    .object({
      host: optionalString(z.string().min(1)),
      port: portSchema.default(3310),
      timeoutMs: intIn(100, 300_000).default(30_000),
      /** false (default): scanner unreachable ⇒ the upload is REJECTED. */
      failOpen: booleanSchema.default(false),
    })
    .default({}),

  webhookSigning: z
    .object({
      secret: optionalString(z.string().min(32, 'webhook signing secret must be at least 32 characters')),
      toleranceSeconds: intIn(1, 86_400).default(300),
    })
    .default({}),

  crypto: z
    .object({
      currentKeyId: optionalString(z.string().regex(KEY_ID_RE, 'key id: 1–64 chars of A-Z a-z 0-9 . _ -')),
      currentKeyRef: optionalString(),
      /** `[{"id":"2025-01","keyRef":"<64 hex chars>"}]` — decrypt-only keys kept for rotation (§15.2). */
      retiredKeys: jsonArray(
        z.object({
          id: z.string().regex(KEY_ID_RE, 'key id: 1–64 chars of A-Z a-z 0-9 . _ -'),
          keyRef: z.string().min(1),
        }),
      ).default([]),
    })
    .default({})
    .superRefine((v, ctx) => {
      if ((v.currentKeyId === undefined) !== (v.currentKeyRef === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [v.currentKeyId === undefined ? 'currentKeyId' : 'currentKeyRef'],
          message: 'security.crypto.currentKeyId and currentKeyRef must be set together',
        });
      }
      const check = (path: Array<string | number>, material: string): void => {
        try {
          decodeKeyMaterial(material);
        } catch (error) {
          // Message only — never the key material itself.
          ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: (error as Error).message });
        }
      };
      if (typeof v.currentKeyRef === 'string') check(['currentKeyRef'], v.currentKeyRef);
      const seen = new Set<string>(v.currentKeyId === undefined ? [] : [v.currentKeyId]);
      v.retiredKeys.forEach((key, index) => {
        if (seen.has(key.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['retiredKeys', index, 'id'], message: `duplicate key id "${key.id}"` });
        }
        seen.add(key.id);
        check(['retiredKeys', index, 'keyRef'], key.keyRef);
      });
    }),
});

export type SecurityConfig = z.infer<typeof securityConfigSchema>;

/** Config paths (relative to the `security` namespace) that hold secret values — RegisterOptions.secretPaths. */
export const SECURITY_SECRET_PATHS: string[] = [
  'webhookSigning.secret',
  'crypto.currentKeyRef',
  'crypto.retiredKeys[].keyRef',
];
