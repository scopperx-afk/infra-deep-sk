# Security Module — Reference & Use Guide

> **Layer 1 (Platform) infrastructure module** · NestJS 11 + TypeScript · Zod 3.25.76 · plain `Symbol()` tokens · depends on **Config + Logger only**
>
> **Implements:** `security-spec-v5.md` (+ the Realtime spec §4.1 `TokenVerifier` contract and HTTP's `WebhookVerificationGuard` hook).
> **Verification status — read §12 first.** The pure logic and the Nest classes were exercised offline (221 tests pass); the parts that need
> `zod`, `argon2`, `sanitize-html`, `fast-xml-parser` or a real Nest runtime could **not** be run in the build sandbox and are written to be run
> on your machine with `npm install && npm test -- security`.

Conventions: a bare `§N` means the **Security spec v5**. `E-S#` are this implementation's deviations/clarifications of that spec (table in [§10](#10-spec-deviations-spec-errata)).

---

## 1. At a glance

| | |
|---|---|
| **What it is** | The platform's security primitives: default-deny auth guard, role-guard base, CSRF, security headers, host/IP/smuggling/HTTPS checks, cookies, crypto (argon2id, AES-256-GCM + rotation, HMAC, signatures), sanitizers, injection defences, malware scan, audit/alert/anomaly/replay ports. |
| **What it is not** | Business auth (login, sessions, refresh, RBAC rules) — that is the domain's. Rate limiting (§7 → Resilience). CORS (§10 → HTTP). |
| **Global behaviour once imported** | Every route requires a valid bearer token unless marked `@Public()`. Every response carries the security headers. |
| **Public surface** | `security/index.ts` only. Plain functions (crypto, sanitize, injection, network, cookies) can be imported by any sibling **without** importing `SecurityModule`. |

### Quick start (4 steps)

```ts
// 1. app.module.ts — ORDER MATTERS: after Config, Logger, Errors and HttpModule
@Module({
  imports: [
    ConfigModule.forRoot({ /* … */ }),
    TracingModule.forRoot(),
    LoggerModule.forRoot({ /* … */ }),
    ErrorsModule,
    HttpModule.forRoot(),
    SecurityModule.forRoot({
      // optional composition-root overrides (all five ports):
      profileValidators: { useFactory: (users: UsersService) => ({ default: new UserValidator(users), admin: new AdminValidator(users) }), inject: [UsersService] },
      imports: [UsersModule], // modules the override's `inject` needs
    }),
  ],
})
export class AppModule {}
```
```ts
// 2. a public route
@Public() @Get('status') status() { return { ok: true }; }
// 3. a protected route needs nothing — it is protected by default
@Get('me') me(@Req() req: { user: AuthPrincipal }) { return { id: req.user.id }; }
```
```bash
# 4. dependencies added to package.json: argon2, sanitize-html, fast-xml-parser, @types/sanitize-html
npm install
```

---

## 2. Design principles

1. **Default-deny.** `AuthGuard` is global (`APP_GUARD`); an unprotected endpoint is one greppable `@Public()`.
2. **Layer 1, domain-agnostic.** No user, role or tenant concepts. The domain plugs in `ProfileValidator`s and writes its own `AbstractRoleGuard` subclasses.
3. **Fail closed.** Unknown input is "does not match", never "skip the check": missing timestamp, missing `rawBody`, unreachable ClamAV (default), undeterminable client IP, a validator returning a mismatched principal.
4. **Algorithms are pinned in code**, never configurable: HS256 only, argon2id, AES-256-GCM, SHA-256. Nothing an attacker or a careless config change can downgrade.
5. **No oracle.** Every bad token gets the same 401; the real reason goes to the DEBUG log, never the response and never including the token.
6. **Ports with shipped defaults.** Alert emitter, anomaly detector, replay store, cache-invalidation bus, profile validators — each has a safe in-process default and a composition-root override.
7. **Secure defaults, relaxed in `.env.development`** — never the reverse. Production refuses to boot with an insecure config (§6.3).

---

## 3. Architecture

### 3.1 Position and dependency rules
Layer 1. Imports **only** `../../config` and `../../logger` (enforced by `boundary.spec.ts`). No sibling imports `SecurityModule` or deep-imports `security/*` (also enforced, in the other direction).

### 3.2 Request pipeline (HTTP spec §3, step 4 onward)

```
… Trace → RequestContext → Logger (HTTP steps 1–3) …
  └─ SecurityHeadersMiddleware      sets all headers first, so every response below carries them
  └─ HostValidationMiddleware       400 INVALID_HOST            (only if security.allowedHosts set)
  └─ RequestSmugglingGuard          400 AMBIGUOUS_BODY_FRAMING
  └─ IP policy                      403 IP_NOT_ALLOWED          (only if security.ipPolicy.* set)
  └─ HttpsEnforcementMiddleware     308 → https://…             (production/staging only)
  └─ AuthGuard (APP_GUARD)          401 / sets req.user
  └─ [route guards: CsrfGuard, your AbstractRoleGuard subclass]
  └─ AuditLogInterceptor            one audit entry for @AuditLog() handlers
```
Middleware rejections respond directly with `{ code, message }` (Errors' wire shape); guard/interceptor failures are thrown `HttpException`s that Errors' `GlobalExceptionFilter` formats.

### 3.3 How the plain-function utilities get Config (E-S1)
`sanitize*`, `checkJsonDepth`, `setSecureCookie`, `scanForMalware`, `encrypt/decrypt` must be importable without DI, yet depend on `security.cookies.*`, `security.injection.*`, `security.clamav.*`, `security.crypto.*`. `SecurityModule` pushes the validated Config values into two tiny holders once at boot (`runtime/security-runtime.ts`, `crypto/key-ring.ts`). Before that happens they hold the **secure** defaults, so a utility used in a script or unit test never fails open.

---

## 4. File tree

```
security/
├── index.ts                  public surface (the only importable file)
├── security.module.ts        forRoot(), middleware order, ports, Config registration
├── security.tokens.ts        all DI tokens (plain Symbol())
├── config/                   security.schema · tokens.schema · security.cross-validation · schema-helpers
├── guards/                   auth.guard · abstract-role.guard · csrf.guard
├── principal/                AuthPrincipal · ProfileValidator · DefaultProfileValidator
├── token/                    jwt.util (HS256 verifier) · bearer.util · token-verifier.factory · token.types
├── decorators/               @Public · @AuditLog
├── interceptors/             audit-log.interceptor
├── middleware/               security-headers · https-enforcement
├── network/                  host-validation · request-smuggling-guard · ip-filter · ip-ranges · trusted-proxy · security-response
├── ip/                       getClientIp · normalizeIp
├── headers/                  csp.builder · csp-nonce.util
├── cookies/                  secure-cookie.util · cookie-reader.util
├── csrf/                     csrf-token.middleware
├── crypto/                   hash · encrypt · key-ring · signature · hmac · compare · random · fingerprint
├── sanitize/                 html · markdown · url (+SSRF) · path · filename · header · unicode
├── injection/                prototype-pollution · redos · json-depth · xml-parser
├── scan/                     malware.util (ClamAV zINSTREAM)
├── alerts/ anomaly/ protocol/ cache/    ports + in-memory defaults
├── runtime/                  security-runtime (Config-derived defaults for plain functions)
├── util/clock.ts             injectable time source
├── testing/                  security-test-utils (helpers for specs)
└── *.spec.ts, boundary.spec.ts
```

---

## 5. API reference (what `index.ts` exports)

### Identity & authorization
| Export | Notes |
|---|---|
| `SecurityModule.forRoot(options?)` | Global dynamic module. Options: `imports`, `profileValidators`, `alertEmitter`, `anomalyDetector`, `replayProtectionStore`, `cacheInvalidationBus`, `clock` — each `{ useClass \| useValue \| useFactory+inject \| useExisting }`. |
| `AuthGuard`, `@Public()`, `IS_PUBLIC_KEY` | Global default-deny. `IS_PUBLIC_KEY` is the plain string `'security:isPublic'` so a sibling that cannot import Security can still set it with `SetMetadata`. |
| `AuthPrincipal` | `{ id, profile, claims, roles?, permissions? }` — `req.user` everywhere. `id === claims.sub`. |
| `ProfileValidator`, `ProfileValidatorRegistry`, `PROFILE_VALIDATORS`, `DefaultProfileValidator` | Account-status hook, one per `tokens.profiles[].name`. `validate(claims, config, profileName?)`. |
| `AbstractRoleGuard` | Roles OR, permissions AND. You write the subclass. |
| `CsrfGuard`, `CsrfTokenMiddleware`, `generateCsrfToken` | Double-submit cookie; per-route, never global. |
| `createTokenVerifier(config)`, `verifyAgainstAnyProfile`, `ALLOWED_ALGORITHMS`, `JwtClaims`, `TokenProfile`, `TokenVerifier`, `VerifiedToken` | The standalone verifier Realtime's `TOKEN_VERIFIER` adapts (returns `null`, never throws). |

### Crypto — `hash`, `verifyHash` *(async, E-S2)*, `encrypt`, `decrypt`, `verifySignature`, `computeFingerprint`, `randomToken`, `randomInt`, `constantTimeEquals`, `hmacSign`, `hmacVerify`

### Sanitization & injection — `sanitizeHtml(input, profile)` (profile **required**), `sanitizeMarkdown`, `sanitizeUrl`, `isSsrfSafeUrl` *(async)*, `sanitizePathSegment`, `isPathWithin`, `sanitizeHeaderValue`, `normalizeUnicode`, `stripInvisibleChars`, `sanitizeFilename`, `isPrototypeSafe`, `safeMerge`, `sanitizeObjectKeys`, `isRegexSafe`, `safeRegex`, `checkJsonDepth`, `createSafeXmlParser`

### Network / cookies / headers — `getClientIp`, `isIpAllowed`, `createIpFilterMiddleware`, `configureTrustProxy`, `setSecureCookie`, `clearSecureCookie`, `setHostCookie`, `setSecurePrefixedCookie`, `generateNonce`, `getCspNonce`

### Ports — `SecurityAlertEmitter` (+`LoggerAlertEmitter`, `SECURITY_ALERT_EMITTER`), `AnomalyDetector` (+`InMemoryAnomalyDetector`, `ANOMALY_DETECTOR`), `ReplayProtectionStore` (+`InMemoryReplayProtectionStore`, `REPLAY_PROTECTION_STORE`), `CacheInvalidationBus` (+`InMemoryCacheInvalidationBus`, `CACHE_INVALIDATION_BUS`), `validateIdempotencyKey`, `generateIdempotencyKey`, `@AuditLog`, `scanForMalware`

---

## 6. Configuration

### 6.1 Namespaces
`security.*` and `tokens.*` are registered by `SecurityModule` through `ConfigModule.forFeature()`. `tokens` is registered here **until an Authentication module exists** (E-S6) — when it does, remove the registration from `forRoot()` and let it own `tokens`, or Config will refuse the duplicate namespace.

### 6.2 Environment variables (all optional unless noted; defaults are the secure choice)

| Variable | Default | Notes |
|---|---|---|
| `TOKENS__PROFILES` | **required** | JSON array in ONE var: `[{"name","secretRef","refreshSecretRef","issuer","audience","accessTtl":"900s","refreshTtl":"30d"}]`. Secrets ≥ 32 chars and **all pairwise distinct**. |
| `SECURITY__TRUST_PROXY` | `false` | `false` / hop count / CIDR+preset list. `true` is rejected in production. |
| `SECURITY__ALLOWED_HOSTS` | *(empty = off)* | `api.example.com,*.example.com,host:8443` |
| `SECURITY__HTTPS_ENFORCEMENT__ENABLED` / `__REDIRECT_STATUS` | `true` / `308` | enforced in production **and staging** |
| `SECURITY__HSTS__MAX_AGE` / `__INCLUDE_SUB_DOMAINS` / `__PRELOAD` | `63072000` / `true` / `false` | `preload` needs includeSubDomains and ≥ 1 year |
| `SECURITY__HEADERS__FRAME_OPTIONS`, `__REFERRER_POLICY`, `__PERMISSIONS_POLICY`, `__COOP`, `__COEP`, `__CORP` | `DENY`, `strict-origin-when-cross-origin`, `camera=()…`, `same-origin`, `require-corp`, `same-origin` | |
| `SECURITY__HEADERS__CSP__ENABLED` / `__REPORT_ONLY` / `__REPORT_URI` / `__USE_NONCE` / `__UPGRADE_INSECURE_REQUESTS` | `true` / `false` / – / `false` / `false` | |
| `SECURITY__HEADERS__CSP__DEFAULT_SRC`, `__SCRIPT_SRC`, `__STYLE_SRC`, `__IMG_SRC`, `__FONT_SRC`, `__CONNECT_SRC`, `__FRAME_SRC`, `__OBJECT_SRC`, `__BASE_URI`, `__FORM_ACTION`, `__FRAME_ANCESTORS` | `'none'` for default/base/form/frame-ancestors, empty otherwise | CSV; no `;`/whitespace allowed inside a source |
| `SECURITY__COOKIES__DEFAULT_SAME_SITE` / `__DEFAULT_SECURE` | `lax` / `true` | |
| `SECURITY__CSRF__ENABLED` / `__COOKIE_NAME` / `__HEADER_NAME` | `true` / `csrf-token` / `x-csrf-token` | prefer `__Host-csrf` in production |
| `SECURITY__INJECTION__MAX_JSON_DEPTH` / `__REDOS_TIMEOUT_MS` / `__STRIP_PROTOTYPE_KEYS` | `20` / `100` / `true` | `false` = reject (400) instead of strip |
| `SECURITY__IP_POLICY__ALLOWLIST` / `__BLOCKLIST` | *(empty)* | CIDR/IP CSV; enforced globally when non-empty (E-S9) |
| `SECURITY__CLAMAV__HOST` / `__PORT` / `__TIMEOUT_MS` / `__FAIL_OPEN` | – / `3310` / `30000` / `false` | |
| `SECURITY__WEBHOOK_SIGNING__SECRET` / `__TOLERANCE_SECONDS` | – / `300` | secret ≥ 32 chars when set |
| `SECURITY__CRYPTO__CURRENT_KEY_ID` / `__CURRENT_KEY_REF` / `__RETIRED_KEYS` | – | key = 32 bytes as 64 hex chars (`openssl rand -hex 32`) or base64; `RETIRED_KEYS='[{"id":"k1","keyRef":"…"}]'` |

Your current `.env` was cross-checked against this schema: every `SECURITY__*`/`TOKENS__*` key maps to a schema field and every present value is valid. `SECURITY__CRYPTO__*` and `SECURITY__WEBHOOK_SIGNING__SECRET` are unset, so `encrypt()` throws until you add a key and no webhook secret is available yet.

### 6.3 Boot-time production rules (`security.cross-validation.ts`)
In `production` the app **refuses to start**, listing every problem at once, if: `TRUST_PROXY=true`, HTTPS enforcement off, `COOKIES__DEFAULT_SECURE=false`, CSP disabled, `HSTS__MAX_AGE` < 1 year, or CSRF disabled. Other environments are unaffected.

---

## 7. Use guide

### 7.1 Authentication flow
`Authorization: Bearer <jwt>` → HS256 only → each profile's `secretRef` is tried against the **signature** (claims are never read to pick a profile) → `exp` required, `iss`/`aud` enforced per profile, ±30 s skew → the profile's `ProfileValidator` → `req.user`.

```ts
@Injectable()
export class UserValidator implements ProfileValidator {
  constructor(private readonly users: UsersService) {}
  async validate(claims: JwtClaims, _config: ConfigService, profile?: string): Promise<AuthPrincipal> {
    const user = await this.users.findActiveById(claims.sub);          // cache this — it runs on EVERY request
    if (!user) throw new UnauthorizedException('Account not available');
    return { id: claims.sub, profile: profile ?? 'default', claims, roles: user.roles, permissions: user.permissions };
  }
}
```
Rules the guard enforces: `principal.id === claims.sub` and `principal.profile === <verified profile>` — otherwise a 500 and an ERROR log (a validator must never mint a different identity). A non-401 failure inside a validator (database down) propagates as a 5xx: it fails **closed**, it is not disguised as a bad token. A profile with no validator uses `DefaultProfileValidator` (sub check only, no roles) and logs one WARN per profile.

### 7.2 Role / permission guards
```ts
@Injectable()
export class AdminGuard extends AbstractRoleGuard {
  protected getRequiredRoles()       { return ['admin', 'moderator']; }   // OR
  protected getRequiredPermissions() { return ['users.suspend']; }         // AND
  protected userHasRole(u: AuthPrincipal, r: string)        { return u.roles?.includes(r) ?? false; }
  protected userHasPermission(u: AuthPrincipal, p: string)  { return u.permissions?.includes(p) ?? false; }
}
@UseGuards(AdminGuard) @Post('users/:id/suspend') suspend() {}
```

### 7.3 Webhooks (HTTP's `WebhookVerificationGuard`)
```ts
import { verifySignature } from '../security';           // plain function, no module import
protected verifySignature(req: RequestWithRawBody, secret: string, toleranceSeconds: number) {
  return verifySignature(req, secret, { toleranceSeconds, signatureHeader: 'x-hub-signature-256', timestampHeader: 'x-hub-timestamp' });
}
```
Default scheme: `x-signature` (hex, optional `sha256=` prefix, several space/comma-separated values accepted for secret rotation) + `x-signature-timestamp`; signed content `${timestamp}.${rawBody}`. A valid-but-stale payload fails exactly like a forged one. For providers that carry a nonce instead, pass `timestampHeader: null` **and** call `ReplayProtectionStore.checkAndMark(nonce, ttl)`.

### 7.4 CSRF (cookie-session routes only)
```ts
consumer.apply(CsrfTokenMiddleware).forRoutes(SessionController);   // issues the cookie
@UseGuards(CsrfGuard) @Post('profile') update() {}                  // requires header === cookie on POST/PUT/PATCH/DELETE
```
Client: read the `csrf-token` cookie and send it back as `x-csrf-token`. Bearer-token routes don't need this.

### 7.5 Cookies
`setSecureCookie(res, 'sid', v, { maxAge: 3600 })` — `maxAge` is **seconds**. `setHostCookie` adds `__Host-` and throws on a `Domain`/non-root path/`secure:false`; `setSecurePrefixedCookie` adds `__Secure-`. Prefixed names are validated even through the generic function. Clear with matching `path`/`domain`.

### 7.6 Encryption with key rotation
```
# rotate: put the OLD key in RETIRED_KEYS, set a NEW id + key as current — no data migration needed
SECURITY__CRYPTO__CURRENT_KEY_ID=2026-10
SECURITY__CRYPTO__CURRENT_KEY_REF=<new 64-hex key>
SECURITY__CRYPTO__RETIRED_KEYS=[{"id":"2026-01","keyRef":"<old 64-hex key>"}]
```
`encrypt()` always uses the current key; `decrypt()` reads the key id off the ciphertext. The key id is bound into the GCM tag, so a ciphertext cannot be re-labelled. Format: `keyId:iv:ciphertext:tag` (base64url).

### 7.7 Sanitizing user content
```ts
sanitizeHtml(comment, 'strict')              // text only
sanitizeHtml(article, 'basic-formatting')    // b/i/p/lists/links (rel forced), no styles/images
sanitizeMarkdown(body); sanitizeUrl(link); sanitizeFilename(upload.name, { allowedExtensions: ['pdf','png'] });
if (!(await isSsrfSafeUrl(webhookUrl))) throw new BadRequestException('URL not allowed');
const parser = createSafeXmlParser();       // rejects DOCTYPE/ENTITY
```

### 7.8 Audit / alerts
`@AuditLog({ action: 'user.suspend', resource: 'user', extractDetails: ctx => ({ target: ctx.switchToHttp().getRequest().params.id }) })` → exactly one `logger.audit(...)` per call (success **and** failure). Inject `SECURITY_ALERT_EMITTER` to raise `SecurityAlert`s; replace the in-memory anomaly detector / replay store with Redis-backed ones for multi-instance deployments.

### 7.9 Realtime
```ts
{ provide: TOKEN_VERIFIER, useFactory: (config: ConfigService) => createTokenVerifier(config), inject: [CONFIG_SERVICE] }
```
Same verification code, same profiles, same pinned algorithm as HTTP.

---

## 8. Rules & anti-patterns

1. Never compare secrets with `===` — `constantTimeEquals` (boundary test enforces).
2. Never read the client IP from a header — `getClientIp(req)`; set `SECURITY__TRUST_PROXY` to the real topology.
3. Never call `verifyAgainstAnyProfile` without an explicit `algorithms` list (boundary test enforces).
4. Never call `sanitizeHtml` without a profile.
5. Don't mark a route `@Public()` to "make it work" — fix the token. Public routes are the exception list.
6. Don't import `SecurityModule` from another module; plain functions come from `'../security'` only.
7. Throw Nest's `UnauthorizedException`/`ForbiddenException`, not custom error classes — Errors maps them.
8. Don't put a secret in a `ProfileValidator` cache key, log line or alert `details`.

---

## 9. Known limitations

- **SSRF check is necessary, not sufficient.** `isSsrfSafeUrl` validates the resolved addresses at check time; a hostile DNS server can return a different address when the HTTP client resolves again (rebinding). The outbound client should connect to a vetted address; keep egress firewall rules.
- **`isRegexSafe` is heuristic** (static scan + bounded dynamic probe) and can block the event loop for up to `probes × timeoutMs` — a pre-flight for untrusted patterns, not a per-request call. For hostile patterns use RE2.
- **In-memory ports are per-process.** The default replay store, anomaly detector and cache bus do not span instances; override them with Redis-backed implementations before running more than one pod.
- **Double-submit CSRF** is protected against cross-site reads by the same-origin policy but not against cookie-tossing from a sibling subdomain — use a `__Host-` cookie name in production.
- **`normalizeUnicode` does not fold cross-script confusables** (Cyrillic `а` vs Latin `a`); that needs a per-field script policy.
- **Non-HTTP contexts** (WebSocket/RPC) are skipped by `AuthGuard` by design; Realtime authenticates at handshake.
- **ClamAV `StreamMaxLength`** (25 MB default) applies; larger files get an `ERROR` reply → rejected (or skipped under `failOpen`).

---

## 10. Spec deviations (SPEC-ERRATA)

| ID | Spec says | Implemented | Why |
|---|---|---|---|
| E-S1 | Plain functions read Config (§13/§15) | Config pushed into a runtime holder at boot; secure defaults before that | A plain function cannot inject `ConfigService`. |
| E-S2 | `hash(): string`, `verifyHash(): boolean` | Both return Promises | argon2id is async-only in Node 22 (`crypto.argon2` is Node ≥ 24.7); sync would block the event loop. |
| E-S3 | `encrypt(value, keyId)` | `keyId` optional; if given it must be the *current* key | Retired keys are decrypt-only (§15.2); the argument is an assertion, not a selector. |
| E-S4 | `verifySignature(req, secret, {toleranceSeconds, algorithm})` — header names unspecified | Defined: `x-signature` + `x-signature-timestamp`, signed `ts.body`, both names overridable, `timestampHeader:null` for body-only | Every provider differs; the spec left the wire scheme open. |
| E-S5 | Middleware rejects with `{ code }` | `{ code, message }` | One error shape for clients to parse. |
| E-S6 | Config owns `tokens.*` | Security registers the namespace (interim) | Config only registers `app`; nothing else would, and the first request would throw `ConfigMissingError`. |
| E-S7 | "jwt.verify with explicit algorithms" | Dependency-free HS256 verifier on `node:crypto` | One algorithm → a few auditable lines; removes the JOSE library's `none`/alg-confusion surface. |
| E-S8 | `CsrfGuard` reads `req.cookies` | Reads `req.cookies` if present, else parses the `Cookie` header | HTTP installs no `cookie-parser`; the sketch would reject every request. |
| E-S9 | §22 middleware table has no IP middleware | Global IP policy applied when `security.ipPolicy.*` is set; SecurityHeaders runs first | An unenforced allow/blocklist is a silent gap; headers-first makes error responses carry headers. |
| E-S10 | §9.1 header list | + `X-Permitted-Cross-Domain-Policies`, `X-DNS-Prefetch-Control`, `X-XSS-Protection: 0`; `X-Powered-By` removed | Standard hardening. |
| E-S11 | Tokens declared beside their ports | All in `security.tokens.ts` | Architecture rule 22. Public names unchanged. |
| E-S12 | HTTPS enforcement in production | Production **and staging**; `/health/live` + `/health/ready` exempt | Staging is internet-reachable; in-cluster probes carry no forwarded-proto and would flap the pod. |
| E-S13 | `allowed.includes(host)` | Case-insensitive, port-aware, `*.` wildcards, structurally validated | Exact-match breaks on `Host: API.example.com` and explicit ports. |
| E-S14 | Reject CL + TE | + malformed CL, any TE ≠ `chunked` | Obfuscated TE values are the actual smuggling vectors. |
| E-S15 | `CsrfTokenMiddleware` has no registration point | Exported | Otherwise it is dead code. |
| E-S16 | `validate(claims, config)` | optional 3rd parameter `profileName` | `DefaultProfileValidator` serves any profile and must set `principal.profile`. |
| E-S17 | `CsrfGuard` checks every request | Skips GET/HEAD/OPTIONS | Safe methods don't change state; requiring a token breaks page loads. |
| E-S18 | `scanForMalware → {clean, signature?}` | + `skipped: true` under `failOpen` | The caller must be able to see the scan did not happen. |
| E-S19 | `AuditLogInterceptor` uses `LOGGER_RUNTIME.audit`; drops anonymous; logs `String(error)` | Uses `ILogger` (`LOGGER_SERVICE`); audits anonymous callers; logs `{name,message≤300,status}` | `LoggerRuntime` has no `audit()`; "exactly one entry per invocation" must hold on public routes; `String(error)` is unbounded. |
| E-S20 | — | **One edit outside this module:** `HealthController` carries `@SetMetadata('security:isPublic', true)` | Without it the global guard 401s the orchestrator's probes. HTTP cannot import Security, so it sets the same plain metadata key. |

---

## 11. Changing the module safely

- Adding a config key: schema → `security.module.ts` bootstrap (if a plain function needs it) → `.env` docs here → `security.schema.spec.ts`.
- Adding an export: it must come through `index.ts`; run `boundary.spec.ts` (it fails on rate-limit/CORS exports, deep imports, new `Symbol()`s outside `security.tokens.ts`, bare `Date.now()`, `process.env`, forwarded-for strings and secret `===`).
- Replacing HS256 verification: change `jwt.util.ts` **and** `ALLOWED_ALGORITHMS` together; the algorithm tests must keep failing for everything not on the list.

---

## 12. Verification

**Ran offline in the build sandbox (221 tests, all passing):** crypto, JWT, `AuthGuard`, `AbstractRoleGuard`, `CsrfGuard`, security-headers, HTTPS-enforcement, host/smuggling/IP/trusted-proxy, cookies + CSRF issuance, sanitizers (non-HTML), injection (prototype pollution, JSON depth, ReDoS), malware scan against a **real TCP fake-clamd speaking the zINSTREAM protocol**, ports, audit interceptor, production cross-validation, and the 31 architectural boundary tests (AST scans + positive controls, including the scan of every sibling module). One real bug was found and fixed by these tests (a tab-obfuscated `javascript:` destination in `sanitizeMarkdown`).
`tsc --strict` over the module (production **and** specs) was clean against hand-written stubs for Nest/Express/Node typings.

**NOT run here — needs `npm install` first (no network in the sandbox):**

| Spec | Needs |
|---|---|
| `config/security.schema.spec.ts`, `config/tokens.schema.spec.ts` | real `zod` |
| `crypto/hash.util.spec.ts` | `argon2` (native) |
| `sanitize/html.util.spec.ts` | `sanitize-html` |
| `injection/xml-parser.util.spec.ts` | `fast-xml-parser` |
| `security.module.spec.ts` | real Nest + `supertest` (full-pipeline integration) |

```bash
npm install
npm test -- security          # all security specs
npx tsc --noEmit && npx eslint src/infrastructure/security
```
If any of those fail, the cause is most likely an exact-output assumption about a third-party library's formatting (`sanitize-html`, `fast-xml-parser`) or a Zod default/pipe detail — the logic they exercise is covered by the passing suites above.
