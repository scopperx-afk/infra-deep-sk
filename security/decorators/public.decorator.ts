/**
 * `@Public()` — Security spec §5.1/§5.4.
 *
 * `AuthGuard` is registered GLOBALLY: every route requires a valid token unless it is
 * explicitly marked. An accidentally-unprotected endpoint is a recurring production-incident
 * class; an accidentally-`@Public()` one is a single, greppable line.
 *
 * The metadata key is a plain string on purpose: a module that cannot import Security (a
 * Layer 1 sibling — HTTP's `HealthController`) can still mark a route public with
 * `SetMetadata('security:isPublic', true)` without a lateral import.
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'security:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
