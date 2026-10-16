import { SetMetadata } from '@nestjs/common';

/**
 * `@SkipEnvelope()` — API Infrastructure spec §4.5. Applied at method or class level. For responses
 * whose body IS the contract: health endpoints (`/health/live`, `/health/ready` — an aggregator's
 * raw response), webhook endpoints that must return a provider-specific acknowledgment, downloads.
 */
export const SKIP_ENVELOPE_KEY = 'api:skipEnvelope';
export const SkipEnvelope = () => SetMetadata(SKIP_ENVELOPE_KEY, true);
