/**
 * `app.*` — Application Identity (Config spec §13.1).
 *
 * The only namespace Config itself owns: `app.env` drives isProduction(), the
 * production secret guard (§9.2) and every environment-dependent cross-namespace
 * rule (§7.4), so it cannot be delegated to another module. Every other namespace
 * is registered by its own module via `ConfigModule.forFeature()` (§12, §17.6).
 */
import { z } from 'zod';
import { portSchema } from './primitives';

export const appConfigSchema = z.object({
  /** From NODE_ENV (§5.1.1, special-cased). `dev` is NOT accepted (§5.7). */
  env: z.enum(['development', 'staging', 'production', 'test']),
  name: z.string().min(1),
  port: portSchema.default(3000),
  /**
   * ⚠️ Consumed by the domain layer, not infrastructure — held here purely as data
   * because it is environment-specific. No app-specific branching near this field.
   */
  frontendUrl: z.string().url(),
  /**
   * No default and no derivation: Config never calls os.hostname(). An
   * orchestrator sets it explicitly. If unset, consumers simply omit it.
   */
  instanceId: z.string().min(1).optional(),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
