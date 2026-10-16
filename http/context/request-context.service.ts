/**
 * `RequestContextService` — HTTP spec §9's DI-injectable form, offered
 * alongside the plain `getRequestContext()` function for the same reason
 * Tracing offers both forms (Tracing spec §4.2): one delegates to the other;
 * there is exactly one underlying store (`requestContextStore`).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { AsyncLocalStorage } from 'node:async_hooks';
import { REQUEST_CONTEXT_STORE } from '../http.tokens';
import type { RequestContext } from './request-context.port';

@Injectable()
export class RequestContextService {
  constructor(@Inject(REQUEST_CONTEXT_STORE) private readonly store: AsyncLocalStorage<RequestContext>) {}

  getContext(): RequestContext | undefined {
    return this.store.getStore();
  }
}
