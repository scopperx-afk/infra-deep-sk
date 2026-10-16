/**
 * Graceful shutdown — HTTP spec §12, step 1 of this project's total shutdown
 * order (business modules' own `OnApplicationShutdown` hooks are step 1 too,
 * conceptually "during/after drain"; Tracing is step 2, Logger step 3 — see
 * `tracing.module.ts`'s and `logger.module.ts`'s own header comments).
 *
 * This is deliberately NOT a Nest `OnApplicationShutdown` provider: draining
 * the HTTP server must happen BEFORE `app.close()` is even called — `close()`
 * is what TRIGGERS every module's own shutdown hooks (business → Tracing →
 * Logger), and those should only start once HTTP has already stopped
 * accepting new work. `installGracefulShutdown()` therefore owns the
 * SIGTERM/SIGINT handler itself and calls `app.close()` as its OWN last step,
 * once draining is done — main.ts calls this instead of
 * `app.enableShutdownHooks()`.
 *
 * ── Design, verified empirically against real Node/Express behavior ────────
 * `server.close()` alone does not reliably signal "done": a kept-alive,
 * now-idle socket from an ALREADY-FINISHED request stays open indefinitely
 * unless swept. `server.closeIdleConnections()` sweeps idle sockets at the
 * moment it's called — a ONE-SHOT action, not an ongoing policy — so it is
 * polled on an interval while waiting, letting each request's socket be swept
 * promptly once ITS response finishes (confirmed: a fast handler drains in
 * one poll tick rather than waiting for the full timeout budget).
 * `server.closeAllConnections()` force-closes whatever is still open once the
 * timeout elapses (confirmed: a slow handler's client sees the connection
 * destroyed at the deadline, not left hanging).
 */
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

export interface GracefulShutdownOptions {
  timeoutMs: number;
  signals?: readonly NodeJS.Signals[];
  pollMs?: number;
  /** Test hook — defaults to `process.exit`. */
  onComplete?: () => void;
}

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
const DEFAULT_POLL_MS = 25;

export function installGracefulShutdown(app: INestApplication, options: GracefulShutdownOptions): () => Promise<void> {
  const server = app.getHttpServer() as Server;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    let closed = false;
    const closedPromise = new Promise<void>((resolve) => {
      server.close(() => {
        closed = true;
        resolve();
      });
    });

    const deadline = Date.now() + options.timeoutMs;
    while (!closed && Date.now() < deadline) {
      server.closeIdleConnections(); // sweep sockets that became idle since the last poll
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (closed) await closedPromise;
    server.closeAllConnections(); // force-close anything still mid-flight past the deadline

    await app.close(); // NOW triggers business/Tracing/Logger's own OnApplicationShutdown hooks
    (options.onComplete ?? (() => process.exit(0)))();
  };

  for (const signal of options.signals ?? DEFAULT_SIGNALS) process.once(signal, () => void shutdown());
  return shutdown; // exposed for tests — never called by application code directly
}
