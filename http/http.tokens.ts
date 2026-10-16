/**
 * DI tokens — HTTP spec §15.
 *
 * Plain Symbol() only, matching every other module's own rule.
 */

// ── Public (re-exported from index.ts) ───────────────────────────────────────
export const REQUEST_CONTEXT_SERVICE = Symbol('REQUEST_CONTEXT_SERVICE'); // §9's DI-injectable form
/**
 * Not in §15's own token list. HTTP spec §11 says `/health/ready`'s aggregation
 * "lives in the Health module" but that module does not exist in this project
 * yet — this is the extension point a future Health module provides an
 * implementation for (the same non-lateral "attach via a token the owning
 * module declares" pattern §14 already uses for `APP_GUARD`/`APP_PIPE`/
 * `APP_FILTER`/`APP_INTERCEPTOR`, applied here across layers since Health
 * cannot be imported by HTTP — see SPEC-ERRATA.md E-H1). Public and
 * `@Optional()`-injected (health/health.controller.ts): HTTP works standalone
 * today and picks up real aggregation the moment Health registers one.
 */
export const READINESS_PROVIDER = Symbol('READINESS_PROVIDER');

// ── Internal — NOT exported from index.ts ────────────────────────────────────
export const REQUEST_CONTEXT_STORE = Symbol('REQUEST_CONTEXT_STORE'); // the AsyncLocalStorage itself
export const HTTP_OPTIONS = Symbol('HTTP_OPTIONS');
