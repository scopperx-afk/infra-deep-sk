import { SetMetadata } from '@nestjs/common';

/**
 * `@RawResponse()` — API Infrastructure spec §4.5. For handlers that write the response themselves
 * (`@Res()` without passthrough). It is a SEPARATE marker from `@SkipEnvelope()` for intent — it
 * says "I own the whole response, not just the body shape" — but the interceptor treats both as
 * "do not touch". (The interceptor also detects an already-sent response on its own, E-A6, so a
 * forgotten marker degrades safely rather than double-writing.)
 */
export const RAW_RESPONSE_KEY = 'api:rawResponse';
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
