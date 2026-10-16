# Infrastructure Layer — المعمارية النهائية v2 (Domain-Agnostic)

**الستاك:** NestJS + TypeScript + Prisma (PostgreSQL) + Redis (Cluster) + MongoDB  + Socket.IO + S3-Compatible Storage + OpenSearch

**القاعدة الذهبية اللي كل موديول هنا بيلتزم بيها:**

> ❌ **صفر Business Logic.** أي موديول هنا لازم يشتغل بنفس الكفاءة على أي مشروع (e-commerce, social app, SaaS, fintech...) من غير ما يعرف حاجة عن الدومين.
>
> ✅ كل موديول بيعرض **Ports (Interfaces)** فقط للخارج، والتفاصيل التقنية محبوسة جواه.

**مرجع الـ Sizing:**
- **Architecture reference target:** ~5K RPS HTTP + ~100K concurrent WebSocket + ~5TB/سنة objects
- **Stress-test ceiling:** 15K RPS (validation مفيش معناه إن الـ reference sizing 15K)
- لو احتجت أكتر من الـ stress ceiling — الـ scaling path موثق في §4

---

## 0. مبادئ حاكمة

1. Ports & Adapters mandatory: Every externally consumed capability is exposed through a port; external consumers depend only on the port contract and never on adapter implementations.
2. Single Public API: Each module exports from one index.ts only; deep imports are prevented via ESLint boundaries.
3. Contract Tests: Any port with more than one adapter must have an abstract test suite applied to all of them.
4. One Adapter at the Start: Every port begins with a single real adapter — building adapters without a real need is forbidden.
5. Config-driven: No process.env outside Config — absolutely.
6. Observability from day one: Every module integrates with the centralized logger and exposes health/metrics instrumentation where applicable.
7. Fail Fast + Graceful Degradation: A missing critical dependency = stop boot. Non-critical = degraded (§6). No silent failures.
8. ADR for every critical decision before implementation.
9. Migrations are not a startup job: Separate init job/CI step + read-only check at boot (§6).
10. Dependency Direction: Dependencies MUST follow the defined architectural layer/module direction. Circular dependencies between modules are prohibited.
11. Single Ownership: Each infrastructure capability MUST have one authoritative owner. Responsibilities MUST NOT be duplicated across modules.
12. Infrastructure Agnosticism: Infrastructure modules MUST remain business-domain agnostic and MUST NOT contain knowledge of users, posts, jobs, consultations, marketplace, notifications, or other business concepts.
13. Explicit Failure Semantics: Every infrastructure capability MUST explicitly define its failure behavior, including timeout, retryability, fallback/degradation, and error propagation. Failures MUST NOT be silently swallowed.
14. No Distributed Transactions — Outbox Only: Any write touching more than one store/service MUST go through the Transactional Outbox pattern with eventual consistency. 2PC, dual-write, and "write to both then fix on failure" are forbidden.
15. Idempotency Is a Default, Not a Feature: Every mutation endpoint, every queue job, and every event consumer MUST be safe to execute more than once. At-least-once delivery guarantees duplicates WILL happen — the only question is whether the system survives them.
16. Graceful Shutdown: Shutdown MUST follow the defined dependency/lifecycle order for each module.
17. Mandatory Timeouts on Every External Call: Every potentially blocking or remote operation MUST have an explicit timeout or deadline appropriate to its execution model. No unbounded external I/O is permitted.
18. Backpressure — Every unbounded or potentially unbounded runtime buffer or collection MUST have an explicit capacity or growth limit and defined overflow behavior.
19. Backward-Compatible Contracts: Contract changes MUST preserve backward compatibility during the supported migration window. Breaking changes require explicit versioning and a migration/deprecation strategy.
20. Injected Time — No Scattered Date.now(): Business and domain logic MUST obtain time through an injectable clock abstraction. Direct system-clock access (Date.now(), new Date(), etc.) MUST NOT be used in business logic.
21. Single Writer Rule: Every persistent data resource MUST have one authoritative owning module responsible for writes. Other modules MUST NOT directly mutate resources they do not own; they interact through the owner's contract or approved integration mechanism.
22. Explicit DI Tokens: All tokens are declared in a single *.tokens.ts file; Symbol.for() is forbidden.
---

## 1. خريطة الطبقات وقاعدة الاعتماد (مُصحّحة)

```
                    ┌─────────────────────────────┐
                    │   Domain / Business Layers  │  ← مش موجودة هنا (core/domains)
                    └──────────────┬──────────────┘
                                   │ (بيستخدموا الـ ports بس)

Dependency Rule: A layer may depend only on lower layers and their public ports. Lower layers MUST NOT depend on higher layers.
Layer 5 → 4 → 3 → 2 → 1 → 0
┌──────────────────────────────────┴───────────────────────────────────────────────────────┐
│ Layer 5 — Integration        External Services                                           │
│ Layer 4 — Experience         Realtime · Search · Media · Notifications                   │
│ Layer 3 — Messaging          Queue · Events(+Publisher) · Idempotency · Resilience       │
│ Layer 2 — Data               Database · Redis · Cache · Storage                          │
│ Layer 1 — Platform           HTTP · Validation · Security · API Infrastructure · Errors  │
│ Layer 0 — Foundation         Config · Tracing(Context) · Logger                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
Domain / Business
       │
       │ ports only
       ▼
Layer 5 — Integration
       ↓
Layer 4 — Experience
       ↓
Layer 3 — Messaging
       ↓
Layer 2 — Data
       ↓
Layer 1 — Platform
       ↓
Layer 0 — Foundation
= Cross-cutting capabilities are placed in the lowest layer that satisfies their dependencies.
= A layer may depend only on lower layers and their public ports. Lower layers MUST NOT depend on higher layers.
- Cross-cutting infrastructure capabilities are placed in the lowest layer that satisfies their dependencies. Their placement does not imply ownership by the messaging domain.
```



Vertical Dependency Rule:
Each layer may depend only on lower layers or directly on Layer 0.
Dependencies on higher layers are forbidden.

Cross-Cutting Observation Rule (one-way only):

Modules may emit metrics and health indicators through approved
low-level ports/interfaces.

Observation infrastructure MUST NOT depend on higher-layer modules
or business/domain code.

Health aggregation MUST operate through registered indicators,
registries, or adapters without introducing reverse dependencies.

Queue ──register──→ Health Registry
Redis ──register──→ Health Registry
DB    ──register──→ Health Registry

Health ──reads──→ Registry

Feature Flags:
Feature-flag consumers may read flag values through the Feature Flags
port. The Feature Flags infrastructure MUST NOT depend on its consumers
or on business/domain modules.

Metrics, Health, and Feature Flags MUST NOT import higher-layer modules.
Their dependencies MUST remain within their permitted lower-layer
dependency direction.

## 2. توزيع المسؤوليات ("Responsibility Boundaries")

| نوع البيانات | بتروح فين | مش فين |
|---|---|---|
| Business Event | **Events** (event bus) | Logger |
| Measurement (رقم) | **Metrics** | Logger |
| Distributed execution flow | **Tracing** | Logger |
| User behavior | **Analytics** (DB/Mongo pipeline) | Logger |
| Compliance record | **Audit** (first-class: level + separate sink) | Logger العادي |
| Operational info | **Logger** | — |

---

## 3. الموديولات بالتفصيل (24 موديول)

### Layer 0 — Foundation

#### 1. Config
- Pluggable source adapter (.env / Vault / AWS Secrets Manager)
- Zod validation عند الإقلاع — fail fast
- Typed namespaces: `config.get('database.pool.max')`
- Secrets by reference، مفيش plain-text
- Hot-reload لـ whitelist محددة بس (feature flags) — الباقي immutable (ADR-002)
- كل موديول بيسجّل schema بتاعه (`registerSchema('queue', schema)`)
- **مالوش dependency على أي حد**

#### 2. Tracing (Context Provider)
- OpenTelemetry SDK + auto-instrumentation (HTTP, DB, Redis, Queue)
- ALS store فيه: `traceId, spanId, correlationId, causationId` — متاح عبر `getTraceContext()` من غير import
- Context propagation عبر async boundaries (يتحط في job/event payload ويتفك عند الـ consumer)
- **ممنوع يستورد من أي موديول تاني**

#### 3. Logger
**المسؤولية: Centralized structured operational logging — بس.** (مش "كل الأحداث" — انظر §2)

- Levels: `trace, debug, info, audit, warn, error, fatal` — **الـ Audit first-class level** (وله separate sink/channel مستقل عن الـ operational logs)
- JSON structured + child loggers (`logger.child({ module: 'queue' })`)
- Correlation ID من الـ ALS store — يتولّد مرة واحدة وينتشر تلقائيًا
- Redaction تلقائي للحقول الحساسة (passwords, tokens, credit cards, OTP) — القايمة configurable من `Config`
- Transports كـ adapters (console في التطوير، aggregator واحد في الإنتاج)
- **يشتغل حتى لو Tracing/Metrics وقعوا** — Logger آخر حاجة مسموح تفشل

---

### Layer 1 — Platform

#### 4. HTTP
- Middleware pipeline: compression, CORS configurable — **not** security headers; those are Security's exclusive job (module 6) even though an earlier draft of this line listed them here too. HTTP's own frozen specification never implements them.
- Request context (correlationId, locale, clientVersion) في ALS
- Request logging بدون bodies حساسة
- Global timeout + API versioning

#### 5. Validation
**المسؤولية: schema/type/format constraints بس.** Validation ≠ sanitization.

- Pipe موحّد (Zod) على كل endpoint
- نفس الـ schemas للـ Queue payloads و Event payloads — source of truth واحد
- Nested + conditional validation + رسائل خطأ موحّدة → `Error Handling`
- **الـ content sanitization (HTML/Markdown/XSS) مش هنا** — دي context-specific وبتتعامل في `Security` أو في الـ domain نفسه حسب نوع المحتوى

#### 6. Security
> **Addendum (Security spec v5):** this module's own specification consolidated what started as five bullets into fourteen generic protection categories — every one of them applicable to *any* endpoint in *any* domain, not auth-specific. The full breakdown lives in the Security spec itself; the list below is this document's updated summary, not a duplicate source of truth.
- Identity resolution (`AuthGuard`) and generic authorization guards (`AbstractRoleGuard`) — ممنوع guards فعلية زي "AdminOnly". **Interim scope note:** credential mechanics (password, OTP, session, JWT issuance/rotation) belong to a separate, not-yet-built Authentication module; until it ships, JWT *verification* is handled here as a stated, temporary exception — see the Security spec's own callout.
- Transport & content security headers (HSTS, CSP, X-Frame-Options, Referrer-Policy, cross-origin isolation headers), HTTPS enforcement, trusted-proxy configuration
- Cookie security (secure/HttpOnly/SameSite defaults, `__Host-`/`__Secure-` prefix helpers)
- CSRF (double-submit cookie) + webhook request signing, with replay protection
- **Content sanitization utilities** — HTML/Markdown, URL (SSRF-aware), path traversal, header-value (CRLF), Unicode normalization, filename — بيشتغلوا حسب نوع المحتوى مش على كل input أعمى
- Injection prevention utilities — prototype pollution, ReDoS, JSON depth, XXE
- Crypto primitives عامة — hash/verify, encrypt/decrypt (with key rotation), HMAC signature verification, secure random, constant-time compare
- Network hardening — IP allow/block-list, Host-header validation, request-smuggling guard
- Audit logging (`@AuditLog()` → Logger's `AUDIT` level) + a pluggable security-alert channel
- Malware scanning (ClamAV) as an opt-in utility for upload-accepting modules
- **Explicitly NOT here:** rate limiting and Slowloris/connection-exhaustion protection — both live in `Resilience` (module 16; `rateLimit.*`/`resilience.slowloris.*` in Config, already true of this document's original Resilience bullet, "HTTP rate limiting (token bucket في Redis)" — an earlier Security draft duplicated this ownership by mistake, now corrected). CORS stays HTTP's exclusive job (module 4) for the same reason — one owner per concern, restated here only because both were mistakenly re-claimed once already.
- **بيُستخدم من:** HTTP, Realtime, External Services, و أي domain module محتاج sanitization/crypto/audit

#### 7. API
- **Cursor-based pagination أساسي** (offset للـ internal/admin بس)
- Filtering/sorting query parser عام
- Response envelope: `{ data, meta, errors }`
- OpenAPI generation

#### 8. Error Handling
- Global Exception Filter → `{ code, message, details, traceId }`
- Taxonomy: Domain / Validation / Infrastructure / Unknown + HTTP mapping
- Error classes extensible (كلهم يرثوا من base موحّد)
- Stack traces في dev بس
- تسجيل تلقائي عبر Logger

---

### Layer 2 — Data

### 9. Database (وحدة واحدة — مخزنين First-Class)

**المسؤولية:** إدارة كل اتصالات البيانات في النظام (SQL + Document) كـ **ports منفصلة**. الاتنين أساسيان ومطلوبان — مفيش "أساسي واختياري".

#### 9.1 تقسيم البيانات (قرار معماري ثابت — ADR-004 Revised)

|  | PostgreSQL (SQL Store) | MongoDB (Document Store) |
| --- | --- | --- |
| **بيشيل إيه** | بيانات الهوية والمستخدم **الثابتة**: auth، credentials، الإعدادات الثابتة للحساب | المحتوى **المتغير بسرعة**: posts، comments، likes، content artifacts |
| **ليه** | relational integrity للـ identity + joins على الـ follow graph لو موجود | schema agility (الـ content بيتغير باستمرار) + توزيع ضغط الكتابة على سيرفر مستقل |
| **مكانته** | Source of truth للهوية | Source of truth للمحتوى |
| **البنية** | سيرفر مستقل (pool + health + metrics منفصلين) | سيرفر مستقل (pool + health + metrics منفصلين) |

> كل مخزن ليه connection management كامل لوحده — مفيش مشاركة pools ولا connections بينهم.

#### 9.2 الـ Ports

```ts
// الـ domain بيستورد الـ port اللي يخصه صراحة — مفيش port واحد بيدّعي إنهم interchangeable
interface SqlStore {
  unitOfWork.run<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;  // ← SQL transactions بس
  queryPrimary(sql: string, params?: unknown[]): Promise<unknown[]>;
  queryReplica(sql: string, params?: unknown[]): Promise<unknown[]>;
  migrationStatus(): Promise<{ upToDate: boolean }>;              // read-only check (§9.4)
}

interface DocumentStore {
  collection<T>(name: string): DocumentCollection<T>;
  withSession(fn: (session: DocSession) => Promise<void>): Promise<void>; // Mongo transactions (تحتاج Replica Set — N-01)
  health(): Promise<StoreHealth>;
}
```

- **Adapter واحد لكل port:** PostgreSQL adapter (Prisma) + MongoDB adapter (Mongoose/Driver) — one-adapter rule محترمة، والـ contract tests جاهزة لو adapter تاني ظهر.
- الـ repositories الفعلية (AuthRepository، PostRepository...) في `core/domains` — الموديول ده بيدي **connections وtransactions بس**.

#### 9.3 القاعدة الحمراء: مفيش Transaction بيمس الاتنين

إنشاء مستخدم = write في PostgreSQL + write في MongoDB. الـ `unitOfWork` **بيشتغل جوه SQL بس** — مفيش distributed transaction، وممنوع حد يبني واحدة.

**الـ consistency pattern المعتمد (ADR-008):**

```javascript
[Domain] unitOfWork (SQL):
   ├─ write user record (Postgres)
   └─ outbox row "user.created" — نفس الـ transaction
→ commit
→ Outbox Publisher ينشر
→ Sync Worker (Queue-backed): ينشئ الـ Mongo document
   ├─ نجاح → done
   ├─ فشل → retry + DLQ
   └─ conflict/reconciliation → nightly reconciliation job
```

- **Eventual consistency مقبولة** بين الهوية والمحتوى — والـ UI بيتعامل معاها (content بيظهر لحظة إنشائه من الـ write-ahead في Mongo أو بيتقرأ من SQL مؤقتًا حسب الـ domain decision)
- **Reconciliation job ليلي** (recurring Queue job): يقارن user IDs في الاتنين ويصلّح أي فروق — الـ safety net ضد أي ضياع event
- أي domain flow تاني بيمس المخزنين لازم يمشي على نفس الـ pattern ده — review checklist item

#### 9.4 Migrations

- **PostgreSQL:** init job/CI step منفصل (ADR-003) + read-only check عند الإقلاع (`migrationStatus()`) — ممنوع migrate من multi-replica app
- **MongoDB:** مفيش schema migrations بالمعنى التقليدي — بدلها:
- **Index definitions** متversioned وبتتطبق في نفس الـ init job (idempotent: `createIndexes` بتتجاهل الموجود)
- **Document shape** متحقق منه عند الـ application level (Validation layer / Zod schemas عند الكتابة) — مش عند قاعدة البيانات

#### 9.5 الفشل والـ Health (مظبوط على واقع التطبيق)

| الحالة | الأثر | السلوك |
| --- | --- | --- |
| PostgreSQL down عند الإقلاع | 🛑 | التطبيق ميردش يقوم (identity = critical) |
| PostgreSQL down في الـ runtime | 🔴 | auth endpoints fail؛ الـ APIs اللي مالهاش auth (content العام cached) ممكن تفضل degraded شغالة |
| MongoDB down عند الإقلاع | 🛑 | التطبيق ميردش يقوم (المحتوى = core للتطبيق) |
| MongoDB down في الـ runtime | 🔴 | content APIs fail مع 503 واضح؛ الـ reads الممكنة من Cache تفضل شغالة (graceful degradation حقيقي مش crash) |

- كل مخزن ليه health indicator مستقل في موديول Health + metrics منفصلة (query latency، pool saturation، slow queries) — **اسم الـ service في الـ metrics بيفرّق بينهم** (`db_sql_*` / `db_doc_*`)

#### 9.6 ملاحظات تشغيلية

- **N-01:** MongoDB transactions (الـ `withSession`) بتتطلب Replica Set حتى في التطوير — الـ docker-compose لازم يشغلها بـ `--replSet`. غير كده الـ withSession مرفوضة config-wise.
- **Load separation مش مجرد فصل مادي:** الـ connection pools وtimeouts والـ circuit breakers (عبر Resilience) لكل مخزن لوحده — ضغط المخزن الواحد ماينتقلش للتاني.
- الـ `queryReplica()` للـ SQL موجود للـ read-heavy paths (مش مستعجل — يتفعّل في Phase 3 مع read replicas)، وMongo الـ read distribution بتاعتها على مستوى الـ deployment (replica set secondaries) مش الـ module.


#### 10. Redis (وحدة واحدة تدير كل الاتصالات)
**المسؤولية:** الـ module الوحيد اللي بيتكلم Redis.

- **One Redis module owns and manages all Redis clients/connections** — الـ adapters جواه ممكن تستخدم الـ topology المطلوبة (Cluster/Sentinel topology-aware connections) حسب الـ deployment المختار. "وحدة واحدة" ≠ "connection واحدة"
- HA: Cluster / Sentinel / managed (ADR-001) — مفيش إنتاج من غير HA
- Key naming إلزامي: `{app}:{module}:{purpose}:{id}` — cluster slotting صحيح + debugging
- Pub/Sub primitives عامة
- Health + metrics + command latency histogram
- **ممنوع `new Redis()` في أي موديول تاني**

#### 11. Cache (L1 + L2 — الترتيب الصح)
```
Database = SOURCE OF TRUTH (الحقيقة الوحيدة)
    ↓
L2 (Redis shared cache layer)
    ↓
L1 (in-memory local cache layer)
```
- L1 ممنوع يتفعّل من غير **invalidation broadcast** (Redis Pub/Sub event لكل instances تمسح L1) — ADR-005
- `cache.wrap(key, ttl, fetchFn)` + stampede protection
- TTL-based + tag-based invalidation + event-driven (عبر Events)
- Namespacing تلقائي + Metrics: hit/miss per namespace

#### 12. Storage (S3-Compatible)
- Adapter واحد في البداية (S3/R2)
- Signed URLs — الملفات مبتعدّيش على سيرفراتنا
- Multipart + resumable uploads
- Content-hash dedup + lifecycle policies
- Virus scan port (adapter لاحق)
- CDN delivery للـ objects العامة
- **⚠️ الـ Storage مش بيعرف "file.uploaded"** — انظر §5 (الـ domain layer هو اللي يكتب الـ outbox row)

---

### Layer 3 — Messaging & Safety

#### 13. Queue (BullMQ)
- Producer/consumer port + adapter واحد
- Retry + exponential backoff + DLQ + alert
- Delayed + recurring jobs
- Priority + concurrency control
- **Contract إلزامي:** `addMany` atomicity + ترتيب مضمون (الـ bug التاريخي)
- Stalled job recovery + idempotency key لكل job

#### 14. Events + Outbox Publisher
- `eventBus.publish(type, payload)` → النشر الفعلي على **outbox table جوه نفس transaction** (ADR-006)
- **Outbox Publisher (worker أول-class):** poller batched (`FOR UPDATE SKIP LOCKED`) — ليه health + metrics + alerting. من غيره الـ outbox بيتملى ومحدش بيقرا
- Event envelope: `{ id, type, payload, occurredAt, correlationId, causationId, realtime?: { targets } }`
- At-least-once + dedup بالتعاون مع Idempotency
- DLQ + replay tool

#### 15. Idempotency
- `Idempotency-Key` interceptor للـ HTTP mutations
- Deduplication لـ Queue jobs و Event consumers
- Response caching (نفس المفتاح + نفس body hash = نفس الرد)
- TTL-based + cleanup دوري

#### 16. Resilience
- Circuit breaker / retry+backoff / timeout / bulkhead — كـ decorators على أي function
- HTTP rate limiting (token bucket في Redis) — `AbstractRateLimitGuard` + its `RateLimitStore` port, reading `rateLimit.default.*`/`rateLimit.login.*` (Config spec §13.12, hot-reload whitelisted per §10.1). Config spec §10.2 names this module, not Security, as the consumer — an earlier Security draft placed this guard under `security/` by mistake; it belongs here because Resilience (Layer 3) sits below no Data-layer restriction Security (Layer 1) would have to invert around.
- Slowloris / connection-exhaustion protection — `resilience.slowloris.headerTimeoutMs` (Config spec §13.12), same "protection tuning under active attack" category as rate limiting, for the same reason kept alongside it rather than under Security.
- Fallback: `cache.getStale()`
- كل breakers بتصدر metrics

---

### Layer 4 — Experience

#### 17. Realtime (Socket.IO + Redis Adapter)
- Horizontal scaling عبر Redis Adapter
- Auth عند الاتصال + token refresh عبر reconnect
- Rooms & Presence (Redis TTL heartbeat)
- Backpressure: bounded buffer + drop policy واضحة
- **⚠️ Realtime مبيعرفش domain events:** الـ routing جاهز في الـ event نفسه كـ metadata (`realtime: { targets: [...] }`) أو عبر routing config/adapter. Realtime بيبعت للـ targets اللي وصلته — مش بيقرر هو (انظر §5)
- Heartbeat + reconnection + missed-events recovery (catch-up من API بـ last-seen eventId)
- Metrics + health

#### 18. Notifications
- Provider abstraction (Push/Email/SMS) — adapter لكل قناة فعلية
- Template rendering عام (ID + data)
- Multi-channel dispatch مع fallback
- **Async عبر Queue** — مفيش إشعار بيحجب الـ request
- Delivery tracking + retry + dedup
- Opt-out enforcement كـ context عام

#### 19. Search (OpenSearch)
- Adapter واحد في البداية
- Indexing عبر `Events` (CDC-like)
- Query builder عام: full-text, filters, facets, autocomplete
- Bulk reindex (Queue-backed) + index lag monitoring

#### 20. Media Processing
- Image pipeline (Sharp): resize/compress/variants ثابتة
- Video: async عبر Queue
- Virus scan integration
- Pipeline steps قابلة للتهيئة (ordered, من config)
- Idempotent بالـ content-hash
- Limits صارمة (size, MIME by magic bytes)

---

### Layer 5 — Integration

#### 21. External Services
- HTTP client موحّد بـ defaults متسقة
- Adapter pattern لكل provider
- Timeout/Retry/Circuit breaker عبر `Resilience` (مش معاد اختراع)
- API key redaction في logs
- Provider rate-limit awareness

---

### Cross-Cutting

#### 22. Metrics
- Prometheus-style + `/metrics` endpoint
- Auto-instrumentation: HTTP, DB, Redis, Queue, Cache, WS
- RED dashboards لكل boundary
- SLA alerts: p99, error rate, Redis memory, DB saturation

#### 23. Health
- `/health/liveness` + `/health/readiness`
- Indicator interface موحّد — كل موديول بيسجل
- **مقسمة required/optional** (§6)
- Graceful degradation reporting

#### 24. Feature Flags
- `flags.isEnabled(key, context)` + percentage rollout + targeting (segments كـ context)
- Provider: local config في البداية، LaunchDarkly/Unleash adapter لاحقًا
- Real-time updates عبر Redis pub/sub
- **Kill-switch capability متاحة للـ features اللي محتاجة operational rollback** — مش إلزامية لكل feature

---

## 4. Scaling Path

| الحمل | الحل | الـ trigger |
|---|---|---|
| RPS > ~1K | Horizontal scale خلف LB (stateless) | CPU/RPS |
| DB read saturation | Read replicas + Cache L2 | replica lag + hit ratio |
| DB write saturation | Partitioning + PgBouncer | write p99 |
| Redis memory > 70% | Key isolation + LRU على cache section بس | Redis memory alert |
| WS > ~15K/instance | Scale instances | connections/instance |
| Queue depth متزايد | Scale consumers | queue depth |
| Storage egress غالي | CDN + lifecycle | egress cost |

---

## 5. سيناريوهات التفاعل (مُصحّحة)

### سيناريو 1: Request عادي
```
Request → HTTP (context) → Security (headers) → Validation (schema check)
        → [Domain Logic في core]
        → Database/Cache عبر UnitOfWork
        → Error Handling / API envelope
تلقائيًا: Tracing + Logger + Metrics
```

### سيناريو 2: Write operation مع نشر حدث (الصح)
```
[Domain/Application layer]:
   ├─ Storage.put(file) ← storage بيرجع objectKey، ميعرفش أي حاجة عن domain
   ├─ write domain record (DB) — جوه UnitOfWork
   └─ outbox row ("document.attached", payload + realtime.targets) — نفس الـ transaction
→ commit
→ Outbox Publisher ينشر
→ Listeners بالتوازي:
   1. Cache      → invalidate
   2. Realtime   → يبعت للـ targets اللي في الـ metadata زي ما هي
   3. Search     → update index
```
**القاعدة:** الـ domain layer هو الوحيد اللي يعرف أسماء الأحداث ومعناها. الـ infrastructure (Storage/Queue/Events/Realtime) بتنقل semantics مش بتختارها.

### سيناريو 3: عملية تقيلة (upload كبير)
```
Client → Storage (signed URL) → الملف يوصل مباشرة
→ [Domain layer] يسجّل metadata + outbox "object.received" (+ processing targets)
→ Publisher → Queue job (idempotent بالـ content-hash)
→ Media Processing (محمي بـ Resilience) → variants → Storage
→ [Domain layer] يسجّل النتيجة + outbox "object.processed" (+ realtime.targets)
→ Realtime يبعت + Notifications لو الـ domain طلب
```

### سيناريو 4: استدعاء API خارجي
```
[Domain] → External Services
→ Resilience (breaker + retry + timeout)
→ فشل نهائي → Error Handling → Metrics → circuit opens + alert
→ (اختياري) Feature Flag kill switch
```

---

## 6. مصفوفة الفشل و Redis HA

### Redis HA (ADR-001)
- Cluster / Sentinel / managed — مفيش إنتاج من غير HA
- Key prefixes إلزامية: `{app}:cache:*`, `{app}:queue:*`, `{app}:pubsub:*`, `{app}:rate:*`
- `allkeys-lru` على الـ cache section بس — queue keys ممنوع تتطرد

### المصفوفة — مفصولة connectivity عن capability (حل التناقض الظاهري)

| الموديول | يوقف الإقلاع؟ | عند الفشل في الـ runtime |
|---|---|---|
| Config, Logger, Tracing, Error Handling | ✅ | — |
| Database (primary connectivity) | ✅ | — |
| **Redis core connectivity** (cache+queue ops) | ✅ | — |
| **Redis Pub/Sub capability** (Realtime bridge) | ⚠️ نعم — degrade | REST شغال، Realtime 503 + clients reconnect |
| MongoDB adapter (لو مفعّل) | ✅ | Buffer + لوغ أو drop حسب config |
| OpenSearch | ❌ | Search unavailable + fallback من الـ domain |
| Media Processing | ❌ | Raw uploads تتعالج لاحقًا |
| Notifications | ❌ | In-app مكمل، خارجي يتسقط مع لوغ |
| External Services | ❌ | Breaker + fallback |

> **التوضيح:** الـ "Redis required" و"Pub/Sub degraded" مش تناقض — ده تمييز بين *الاتصال بالـ Redis* (required) و*قدرة معينة جواه* (ممكن تتعطل/degrade). Smoke test لازم يثبت إن كل optional فعلاً بيشتغل degraded.

---

## 7. الاختبارات

1. Unit tests لكل adapter ضد الـ port
2. Contract tests (suite مجرد لكل port — ضد تناقض السلوك زي bug الـ `addMany`)
3. Integration: Testcontainers (Postgres + Redis + Mongo)
4. Load: k6 — **الهدف المرجعي 5K RPS sustained + 100K WS**، والـ **15K RPS stress ceiling** (validation إن فيه headroom، مش الـ reference sizing)
5. Chaos (متقدم): قتل Redis node / DB replica — التطبيق degraded شغال ويرجع تلقائيًا

---

## 8. خارطة الطريق

**المرحلة 1 — Spine:** Config, Tracing, Logger, Error Handling, HTTP, Validation, Security, API, Database, Redis, Cache (L2), Queue, MongoDB adapter,Events+Publisher, Idempotency, Resilience, Health, Metrics
**المرحلة 2 — Experience:** Realtime, Notifications, Storage signed URLs + CDN, Media (images), Feature Flags
**المرحلة 3 — Hardening:** Redis HA, Video pipeline, Search, , replicas + partitioning, load + chaos tests

> مفيش مرحلة "infrastructure only" — كل مرحلة نظام شغال، ولا انتقال قبل استقرار شهر.

---

## 9. ADRs

| ID | القرار | الحالة |
|---|---|---|
| ADR-001 | Redis HA flavor | مطلوب قبل أول إنتاج |
| ADR-002 | Config hot-reload whitelist | مطلوب |
| ADR-003 | Migrations كـ init job | ✅ متخذ |
| ADR-005 | L1 = invalidation broadcast أو إلغاء | مطلوب قبل تفعيل L1 |
| ADR-006 | Outbox + Publisher (domain-only event semantics) | ✅ متخذ |
| ADR-007 | Realtime routing عبر event metadata مش event-type mapping | ✅ متخذ |
ADR-008 | Cross-store consistency: outbox + sync worker + reconciliation |
---

## 10. أسئلة مفتوحة

1. Redis HA flavor: Cluster / Sentinel / managed؟
2. Multi-region من الأول؟ (مقترح: لأ — single region + CDN)
3. MongoDB adapter فعلاً محتاجينه في البداية؟ (نعم في نفس اهميه ال postgre)
4. Notifications: القنوات الفعلية للإنتاج الأول؟ (كل قناة = adapter + provider + costs)
5. Compliance: data residency / deletion guarantees من اليوم الأول؟ (بيأثر على Storage lifecycle + backup strategy)
