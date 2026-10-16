/**
 * http/index.ts — the ONLY public surface of the HTTP module (§15), mirroring
 * every other module's own barrel. Everything else (the timeout middleware's
 * internals, the CORS/body-parser factories, the concrete Express wiring) is
 * unreachable from outside `http/`, enforced by the same ESLint boundary rule
 * every other module uses.
 */
export { HttpModule } from './http.module';
export { REQUEST_CONTEXT_SERVICE, READINESS_PROVIDER } from './http.tokens'; // NOT the internal ones (§15)

export type { RequestContext } from './context/request-context.port';
export { getRequestContext } from './context/request-context.store'; // §9's plain, no-DI form
export { RequestContextService } from './context/request-context.service';

export type { ReadinessProvider, ReadinessResult, ReadinessStatus } from './health/readiness-provider.port';

export { WebhookVerificationGuard } from './webhook/webhook-verification.guard';
export type { RequestWithRawBody } from './middleware/body-parser.config';

export { LoggerAuthEnrichmentInterceptor } from './interceptors/logger-auth-enrichment.interceptor';

export { configureHttpPlatform } from './bootstrap/platform.adapter';
export { installGracefulShutdown } from './shutdown/http-shutdown.hook';
export type { GracefulShutdownOptions } from './shutdown/http-shutdown.hook';

export type { HttpConfig } from './config/http.schema';
