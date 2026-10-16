/**
 * DI tokens — Validation spec §12. Intentionally EMPTY.
 *
 * `ZodValidationPipe` (§4) takes no injected dependencies, and nothing else in
 * this module needs to be resolved through Nest's DI container. That is not an
 * oversight: this module has no dependencies to token at all (§2 — no Config, no
 * Tracing, no Logger, no Layer 1 sibling), so there is nothing a token could
 * name. Compare `errors.tokens.ts`, which exists because Errors has a mapper and
 * a metrics collector that OTHER modules resolve; Validation has neither.
 *
 * `export {}` is the one non-comment line, and it is not a token: under this
 * project's `isolatedModules: true` it makes the file an unambiguous ES module
 * rather than a global script, so it can never leak declarations into the global
 * scope or be mis-resolved by a bundler. (On the TypeScript in use a comment-only
 * file also compiles, so this is belt-and-braces, not a workaround.)
 * `boundary.spec.ts` asserts it stays exactly this — no `Symbol()`, no exports.
 */
export {};
