/**
 * `createTokenVerifier()` — the standalone verification entry point Realtime spec §4.1
 * asks Security to ship ("one verification implementation, two callers"): `AuthGuard`
 * calls `verifyAgainstAnyProfile()` directly with the same inputs this wrapper uses, so a
 * WebSocket handshake and an HTTP request are verified by literally the same code against
 * the same `tokens.profiles` and the same pinned algorithm allow-list.
 *
 * Contract (Realtime's `TokenVerifier` port): returns `null` on ANY failure and NEVER
 * throws — including when `tokens.profiles` is unreadable.
 */
import type { ConfigService } from '../../config';
import type { Clock } from '../util/clock';
import { DEFAULT_CLOCK_TOLERANCE_SECONDS, verifyAgainstAnyProfile } from './jwt.util';
import { ALLOWED_ALGORITHMS, type TokenProfile, type TokenVerifier } from './token.types';

export function createTokenVerifier(
  config: ConfigService,
  options: { readonly clock?: Clock; readonly clockToleranceSeconds?: number } = {},
): TokenVerifier {
  return {
    verify: (token) => {
      try {
        const profiles = config.get<readonly TokenProfile[]>('tokens.profiles');
        const result = verifyAgainstAnyProfile(token, profiles, {
          algorithms: ALLOWED_ALGORITHMS,
          clockToleranceSeconds: options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
          ...(options.clock ? { clock: options.clock } : {}),
        });
        return result.profile ? { profile: result.profile, claims: result.claims } : null;
      } catch {
        return null;
      }
    },
  };
}
