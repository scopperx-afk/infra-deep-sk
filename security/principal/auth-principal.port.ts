/**
 * `AuthPrincipal` — the unified `req.user` contract, Security spec §5.2.
 *
 * Every guard in this module sets `req.user` to this shape. No aliases (`req.admin`,
 * `req.provider`) exist. Consumers — Logger (via HTTP's `LoggerAuthEnrichmentInterceptor`),
 * Errors, HTTP, Realtime's `socket.data.user` — read `.id` and never branch on `.profile`.
 */
export interface AuthPrincipal {
  /** Canonical identifier — always equals `claims.sub`. Logger's `enrichLogContext({ userId })` reads this. */
  readonly id: string;
  /** Matches `tokens.profiles[].name`. Free-form string, never interpreted by this module. */
  readonly profile: string;
  /** Verified JWT payload, verbatim. */
  readonly claims: { readonly sub: string; readonly [key: string]: unknown };
  /** Resolved at request time by the domain — NOT read from the JWT. `undefined` = no role system for this profile; `[]` = resolved, zero roles. */
  readonly roles?: readonly string[];
  /** Same resolution rule as `roles`. Domain-owned names. */
  readonly permissions?: readonly string[];
}
