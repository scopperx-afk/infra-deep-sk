/**
 * `ValidationModule` — Validation spec §10. Registers `ZodValidationPipe`
 * through Nest's own `APP_PIPE` token, which wires it into HTTP's authoritative
 * pipeline (HTTP spec §3) at step 7 — after Guards and the before-handler
 * Interceptor phase, before the route handler. `AppModule`, the composition root,
 * imports this once, plainly (`imports: [ValidationModule]`); nothing else imports
 * it. Same attach-via-framework-token mechanism HTTP §14 and Errors §15 use for
 * their own siblings, so there is no lateral Layer 1 import in either direction.
 *
 * No `forRoot()` and no `forFeature()` (§10): there is nothing per-consumer to
 * register — a DTO registers itself by being declared via `createZodDto()` (§4),
 * and a Queue/Event boundary just calls `validate()` (§9). Unlike `ErrorsModule`
 * it is not `@Global()`: it exports nothing, because nothing is meant to be
 * resolved from it through DI (§12 — the tokens file is intentionally empty).
 *
 * ── Finding on spec §11 (SPEC-ERRATA E-V1) — accepted, remedy below ────
 * §11 claims `APP_PIPE`, unlike `APP_FILTER`, "applies uniformly" to WebSocket
 * `@MessageBody()` parameters, so no per-gateway registration is needed. Probed
 * on `@nestjs/websockets` / `@nestjs/core` 11.2.7 with a real socket.io client:
 * it does NOT. The pipe is never invoked for a gateway handler — a valid payload
 * arrives without its schema defaults applied, and an INVALID payload reaches the
 * handler unvalidated. The control (same pipe via `@UsePipes` on the gateway) validates
 * correctly, so the pipe is sound; only the global registration does not reach.
 * Root cause: `SocketModule` builds the WS context with
 * `new PipesContextCreator(container)` — no `ApplicationConfig` — and
 * `getGlobalMetadata()` returns `[]` when `!this.config`. It is the same shape of
 * construction that makes `APP_FILTER` miss gateways (Errors §9), which Errors
 * correctly documents; §11 assumed pipes differ and they do not.
 *
 * Resolution (spec owner, accepted): option (a). `ZodValidationPipe` is exported from
 * `index.ts`, and every WebSocket gateway applies it explicitly with
 * `@UsePipes(ZodValidationPipe)` — mirroring Errors' `WsExceptionFilter`. §12 and
 * §15 #7 are amended to match: it is the same class applied per-gateway, not a
 * separate `WsZodValidationPipe`. Registering `ValidationModule` still makes no
 * claim about gateways — it covers HTTP only. And the export is HTTP-hostile if
 * misused: never `@UsePipes` it on an HTTP handler (E-V6, see the Pipe's header).
 */
import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from './pipes/zod-validation.pipe';

@Module({
  providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }],
})
export class ValidationModule {}
