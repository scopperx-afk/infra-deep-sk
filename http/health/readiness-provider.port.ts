/**
 * `ReadinessProvider` — the shape `/health/ready` needs from "the Health
 * aggregator module" (HTTP spec §11), which does not exist yet in this
 * project. See `http.tokens.ts`'s own comment on `READINESS_PROVIDER` and
 * SPEC-ERRATA.md E-H1 for why this port and token live here rather than
 * HTTP silently doing its own aggregation (§16's file comment is explicit:
 * "routes only; aggregation lives in the Health module").
 */
export type ReadinessStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ReadinessResult {
  status: ReadinessStatus;
  /** Per-dependency detail, whatever shape the Health module decides on —
   *  intentionally loose here since HTTP does not own or interpret it. */
  components?: Record<string, unknown>;
}

export interface ReadinessProvider {
  getReadiness(): ReadinessResult | Promise<ReadinessResult>;
}
