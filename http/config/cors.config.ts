/**
 * Builds the CORS options `NestFactory.create(AppModule, { cors })` (or
 * `app.enableCors()`) expects, from `http.cors.*` — HTTP spec §5.
 *
 * The `credentials=true` + wildcard-origin combination is rejected at Config
 * BOOT TIME already (this namespace's own schema, `config/http.schema.ts`) —
 * by the time this factory runs, that combination is structurally impossible,
 * so this function does not re-check it (defense-in-depth would be
 * redundant, not additive, since the only way to reach this function at all
 * is past that validation).
 */
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { HttpConfig } from './http.schema';

export function buildCorsOptions(http: HttpConfig): CorsOptions {
  const { origins, credentials } = http.cors;
  // A literal '*' token becomes the literal `Access-Control-Allow-Origin: *` header (via the
  // `cors` package's own `origin: '*'` string form) — NOT `origin: true` (which REFLECTS the
  // request's own Origin header instead of emitting a literal "*", a materially different and
  // narrower behavior the config value doesn't ask for).
  const origin: CorsOptions['origin'] = origins.includes('*') ? '*' : origins;
  return { origin, credentials };
}
