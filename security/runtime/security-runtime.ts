/**
 * Runtime defaults for the plain, no-DI utility surface (§13, §15).
 *
 * Spec §13 requires `sanitize*`, `checkJsonDepth`, `setSecureCookie`, `scanForMalware`
 * … to be plain functions importable by ANY sibling without importing `SecurityModule`
 * (Tracing's `deriveContext()` / Logger's `enrichLogContext()` pattern). But several of
 * them have behaviour that depends on Config (`security.cookies.*`,
 * `security.injection.*`, `security.clamav.*`) — and a plain function cannot inject
 * `ConfigService`.
 *
 * Resolution (SPEC-ERRATA E-S1): `SecurityModule` pushes the already-validated,
 * already-frozen Config values into this holder ONCE at boot (see
 * `security.module.ts` → `SECURITY_RUNTIME_BOOTSTRAP`). Until/unless that happens the
 * holder carries the SECURE defaults — a utility used before the module is wired (a
 * unit test, a script) never fails open.
 *
 * Not hot-reloadable by design: nothing under `security.*` is whitelisted (§23).
 */
export type SameSite = 'lax' | 'strict' | 'none';

export interface SecurityRuntimeDefaults {
  readonly cookies: {
    readonly defaultSameSite: SameSite;
    readonly defaultSecure: boolean;
  };
  readonly injection: {
    readonly maxJsonDepth: number;
    readonly redosTimeoutMs: number;
    /** true → strip prototype-polluting keys silently; false → reject the payload (400). */
    readonly stripPrototypeKeys: boolean;
  };
  readonly clamav: {
    readonly host: string | undefined;
    readonly port: number;
    readonly timeoutMs: number;
    readonly failOpen: boolean;
  };
}

export const SECURE_RUNTIME_DEFAULTS: SecurityRuntimeDefaults = Object.freeze({
  cookies: Object.freeze({ defaultSameSite: 'lax' as SameSite, defaultSecure: true }),
  injection: Object.freeze({ maxJsonDepth: 20, redosTimeoutMs: 100, stripPrototypeKeys: true }),
  clamav: Object.freeze({ host: undefined, port: 3310, timeoutMs: 30_000, failOpen: false }),
});

let current: SecurityRuntimeDefaults = SECURE_RUNTIME_DEFAULTS;

export function getSecurityRuntime(): SecurityRuntimeDefaults {
  return current;
}

/** Called once by `SecurityModule` at boot. Replaces the whole snapshot atomically. */
export function configureSecurityRuntime(next: SecurityRuntimeDefaults): void {
  current = Object.freeze({
    cookies: Object.freeze({ ...next.cookies }),
    injection: Object.freeze({ ...next.injection }),
    clamav: Object.freeze({ ...next.clamav }),
  });
}

/** Test utility — restores the secure defaults. */
export function resetSecurityRuntime(): void {
  current = SECURE_RUNTIME_DEFAULTS;
}
