# `infrastructure/shared` — Reference & Use Guide

> Plain, stateless helpers that more than one module needs and **no single module may own**. Not a Nest module: no DI, no lifecycle, no state — import and call.
> Implements: Resilience spec §6.2 (`computeBackoff`), Database spec §8 / Redis spec §7 / Storage spec §11.2 (`connectWithRetry`).
> Depends on: `../config` (public index, for the shared config schema) and a **type-only** `../logger` import. Nothing else.

## 1. What is in it

| File | Export | Used by |
|---|---|---|
| `computeBackoff.ts` | `computeBackoff(attempt, opts, random?)`, `BackoffOptions` | Resilience retry loop, Queue's BullMQ custom backoff, Events' relay, `connectWithRetry` |
| `connect-with-retry.ts` | `connectWithRetry(params)`, `abortableSleep`, `describeConnectError`, `ConnectAttemptTimeoutError`, `ConnectAbortedError` | Database (Postgres + Mongo), Redis (client + subscriber), Storage, Queue, Events transport |
| `transient-network-error.ts` | `isTransientNetworkError(err)` | building block for each module's `isRetryable` |
| `connect-retry.schema.ts` | `connectRetrySchema`, `DEFAULT_CONNECT_RETRY`, `ConnectRetryConfig` | the `*.connectRetry.*` Config block of every connection-owning module |
| `index.ts` | barrel | — |

**File names are spec-mandated.** The Resilience, Events and Queue specs import `infrastructure/shared/computeBackoff.ts` and `shared/connect-with-retry.ts` by those exact paths (note the camelCase `computeBackoff.ts`). Do not rename them to kebab-case; the boundary spec asserts they exist.

## 2. `computeBackoff`

`delay = min(backoffMs × 2^attempt, maxDelayMs) ± jitterRatio` — ceiling applied **before** jitter, so the worst case is `maxDelayMs × (1 + jitterRatio)`.

```ts
computeBackoff(0, { backoffMs: 500, maxDelayMs: 8000, jitterRatio: 0.2 });   // ≈ 400…600
```
- `attempt` is **zero-based**. BullMQ's `attemptsMade` is one-based → pass `attemptsMade - 1`.
- `random` (3rd arg) is injectable for deterministic tests; default `Math.random` (jitter needs de-correlation, not unpredictability).
- Invalid options throw `RangeError` (a NaN delay used to flow through to `setTimeout(NaN)` = fire immediately = a hot retry loop).
- A non-finite `attempt` is read as 0; a broken RNG degrades to "no jitter".

## 3. `connectWithRetry`

```ts
const { attempts, elapsedMs } = await connectWithRetry({
  name: 'redis',                                   // log prefix: 'redis connected', …
  connect: (signal) => client.connect(),           // must be safe to call again; honour `signal` if the driver can
  retry: config.getNamespace<RedisConfig>('redis').connectRetry,   // ConnectRetryOptions
  logger,                                          // ILogger (info / warn / fatal used)
  isRetryable: isRedisRetryable,                   // permanent failures abort immediately
  signal: shutdownController.signal,               // optional: SIGTERM while booting
});
```

### Behaviour
- Success logs `logger.info('<name> connected', { attempt })` — **the metadata shape is pinned by the Database/Redis spec tests**; `elapsedMs` is in the return value, not in the log.
- A failed attempt → `warn('<name> connection attempt N failed, retrying in Xms', { attempt, maxAttempts, delayMs, errorName, errorMessage, errorCode? })`.
- Exhaustion, a non-retryable error, or the overall deadline → **one** `fatal`, then the **original** error is rethrown unchanged (so callers can still inspect driver error codes). Boot fails loudly.
- Cancellation (`signal`) → `ConnectAbortedError`, never retried; interrupts a sleeping back-off immediately.

### Why it differs from the specs' first sketch (database/SPEC-ERRATA.md D-1)
| # | Sketch | Here | Reason |
|---|---|---|---|
| 1 | `delay × 2` | `computeBackoff` with jitter | a fleet booting together must not retry in lock-step |
| 2 | retry everything | `isRetryable` | retrying a wrong password 5× can trip lock-out / fail2ban |
| 3 | `$connect?()/connect?()` duck-typing | `connect(signal)` callback | one function for Prisma, pg, Mongo, ioredis, S3 |
| 4 | no timeout | **per-attempt timeout, default 10 s** | an attempt that never settles froze boot forever (`pg` has no default connect timeout; a firewall dropping SYNs hangs any driver) |
| 5 | — | optional `overallDeadlineMs` | bounds the whole sequence for an orchestrator's startup probe; same semantics as Resilience §6 |
| 6 | — | `AbortSignal` in and out | shutdown during boot; drivers can release half-open sockets |
| 7 | `Math.max(1, NaN)` = `NaN` → infinite loop | validated up front, `RangeError` | a config bug must not become an infinite loop |
| 8 | `logger.warn(msg, err, meta)` (type error: `warn` takes metadata only) | `describeConnectError()` | name/code/message only; credentials in URLs and `password=…` masked; control chars stripped; ≤ 300 chars |

### What `connect` must guarantee
It is called again after a failed or timed-out attempt on the **same client**, so it must be re-invocable (Prisma `$connect`, an ioredis client created with `lazyConnect: true`, a fresh `MongoClient.connect()`). An attempt abandoned after its timeout is *ignored*, not killed — its late rejection is swallowed so it cannot crash the process, and the `signal` it received is aborted so a cooperative driver can clean up.

### Writing `isRetryable` (the shared code cannot — it may not import drivers)
Default is "retry everything" (spec-compatible). Compose `isTransientNetworkError` with the driver's own permanent-failure vocabulary:

```ts
// Prisma:  permanent  P1000 auth failed · P1003 database does not exist · P1010 access denied · P1012 schema invalid
//          retryable  P1001 unreachable · P1002 timed out · P1017 server closed the connection
const PRISMA_PERMANENT = new Set(['P1000', 'P1003', 'P1010', 'P1012']);
const isDatabaseRetryable = (e: unknown) => !PRISMA_PERMANENT.has((e as { code?: string }).code ?? '');

// pg SQLSTATE: permanent 28P01 invalid password · 28000 invalid authorization · 3D000 unknown database · 42501 privilege
//              retryable 57P03 cannot_connect_now (still starting) · 53300 too_many_connections
// ioredis:     permanent message starts with WRONGPASS | NOAUTH | NOPERM
const isRedisRetryable = (e: unknown) => !/^(WRONGPASS|NOAUTH|NOPERM)\b/.test((e as Error)?.message ?? '');
// Mongo:       permanent MongoServerError code 18 (AuthenticationFailed) · MongoParseError
// S3 (SDK v3): permanent err.name ∈ InvalidAccessKeyId · SignatureDoesNotMatch · NoSuchBucket · AccessDenied
```
A classifier that throws is treated as **permanent** (fail closed) and logged — a buggy predicate must not become a long blind retry.

⚠ **ioredis:** the client has its own reconnect strategy. Verify against your ioredis version that during boot only *one* of {this loop, the client's `retryStrategy`} retries (the usual setup: `lazyConnect: true`, and a `retryStrategy` that gives up until the first successful connection).

## 4. Config — `connectRetrySchema`

One shape and one set of defaults for every connection-owning module. Each module nests it under its own namespace (separate budgets, separate counters — Database spec §8):

```ts
const redisSchema = z.object({ /* … */ connectRetry: connectRetrySchema });   // REDIS__CONNECT_RETRY__MAX_ATTEMPTS …
```
| Key | Default | Notes |
|---|---|---|
| `maxAttempts` | `5` | 1–100 |
| `initialDelayMs` | `500` | |
| `maxDelayMs` | `8000` | ≥ `initialDelayMs`; 5 × 500 ms → 8 s ceiling ≈ 15 s total |
| `jitterRatio` | `0.2` | **new, optional** |
| `attemptTimeoutMs` | `10000` | **new, optional** |
| `overallDeadlineMs` | *(none)* | **new, optional**; ≥ `attemptTimeoutMs`; empty string = unset |

Your existing `.env` (`DATABASE__`, `MONGO__`, `REDIS__`, `QUEUE__`, `EVENTS__TRANSPORT__`, `STORAGE__` `CONNECT_RETRY__{MAX_ATTEMPTS,INITIAL_DELAY_MS,MAX_DELAY_MS}`) stays valid unchanged. Per Database spec rule 6, the three new keys must also be added to Config's catalog.

## 5. Integration checklist
- [ ] Database, Redis, Storage, Queue and Events import from `'../shared'` (or the two direct file paths); **never** another module's copy.
- [ ] Their `boundary.spec.ts` / ESLint boundaries allow `../shared` (e.g. Security's own rule allows only `config` + `logger` — Security does not use `shared`).
- [ ] Resilience (retry loop), Queue (BullMQ strategy) and Events (relay) call `computeBackoff` from here — **no second copy** of the formula.
- [ ] Each module defines its own `isRetryable`; the three extra config keys are added to Config's catalog.

## 6. Verification
Ran offline (Node 22): **77 tests passing** — `computeBackoff` (11), `connectWithRetry` incl. real-timer timeout / abort-mid-sleep / late-rejection-after-timeout / injected-clock deadline (33), `isTransientNetworkError` (13), and the boundary spec with positive controls (20). `tsc --strict` + unused-locals clean against stubs.
**Not run here (needs `npm install`, no network in the sandbox):** `connect-retry.schema.spec.ts` (real `zod`).
```bash
npm test -- shared
```
