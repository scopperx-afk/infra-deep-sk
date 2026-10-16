/**
 * The concrete auto-instrumentation package list (§7) + the two startup
 * self-checks tracing.bootstrap.ts runs (.env leakage, §6's warning callout;
 * instrumentation-attachment, §7's closing paragraph).
 *
 * §7 is explicit that this project takes a "one adapter at a time, per
 * capability" approach, matching the actual stack — NOT a generic
 * "instrument everything OpenTelemetry has a package for" approach. §15.1's
 * own bootstrap sketch imports `getNodeAutoInstrumentations` from
 * `@opentelemetry/auto-instrumentations-node`, which is the meta-package that
 * *does* instrument everything unless individually disabled — that sketch is
 * illustrative shorthand, not a literal instruction to use the meta-package.
 * This file instantiates each §7-approved instrumentation individually
 * instead, so the "Build now" / "Build when" / "Deliberately deferred"
 * distinction in §7's table is enforced by what's actually imported here, not
 * left to a config object's enabled/disabled flags on a package that pulls in
 * every instrumentation's own transitive dependency regardless.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
// integration package, not an OpenTelemetry-namespaced one (§7's table).
import { PrismaInstrumentation } from '@prisma/instrumentation';
import type { TracingObservation } from './tracing.health';

/**
 * §7's "Build now" rows, each instantiated directly rather than resolved
 * through the auto-instrumentations-node meta-package (see this file's own
 * doc comment above).
 *
 * - HttpInstrumentation: also what extracts/continues the W3C traceparent
 *   header automatically for both directions (§8.0, §8.1).
 * - UndiciInstrumentation: only actually produces spans if External Services'
 *   concrete adapter uses global fetch rather than an http-based client
 *   library — confirm this before finalizing (§7's own caveat on this row).
 * - PrismaInstrumentation: requires `previewFeatures = ["tracing"]` in
 *   schema.prisma to actually emit spans, and the preview-flag name is
 *   version-sensitive — verify against the pinned Prisma version (§7).
 * - IORedisInstrumentation: swap for the matching package if the Redis
 *   module's concrete client differs, and finalize alongside ADR-001 once
 *   the Redis topology (single-endpoint vs. Cluster/Sentinel) is decided (§7).
 *
 * Queue instrumentation is intentionally absent: no transport auto-
 * instruments this project's custom in-house queue today (§7's Queue row),
 * so runAsBoundary() (§4.1, §8.2) is the documented mechanism there instead
 * of an auto-instrumentation package.
 */
export function buildInstrumentations(): Instrumentation[] {
  return [
    new HttpInstrumentation(),
    new UndiciInstrumentation(),
    new PrismaInstrumentation(),
    new IORedisInstrumentation(),
  ];
}

const ENV_FILE_PATTERN = /^\.env(\..+)?$/;
const OTEL_KEY_PATTERN = /^\s*OTEL_[A-Z0-9_]+\s*=/m;

/**
 * §6's warning callout: a plain fs.readFileSync scan of every .env* file at
 * the project root — never a Config loader, never an import of `config/` —
 * for any OTEL_*-prefixed key. Deliberately a glob over every `.env*` file
 * present, not a fixed list, so a value misplaced in `.env.production` is
 * caught exactly as readily as one in plain `.env`. Best-effort only: a
 * directory or file read failure here must never block boot (§10 — Tracing
 * is unconditionally non-critical).
 */
export function checkEnvFileLeakage(rootDir: string = process.cwd()): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(rootDir);
  } catch {
    return; // best-effort only — a directory read failure must never block boot (§10).
  }
  for (const name of entries) {
    if (!ENV_FILE_PATTERN.test(name)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(rootDir, name), 'utf8');
    } catch {
      continue;
    }
    if (OTEL_KEY_PATTERN.test(content)) {
      process.stderr.write(
        `OTEL_* found in .env file, ignored — see Tracing spec §6 (file: ${name})\n`,
      );
    }
  }
}
