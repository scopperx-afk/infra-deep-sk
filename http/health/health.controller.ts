/**
 * `HealthController` — HTTP spec §11. Routes only; aggregation lives in the
 * Health module (§16's own file comment) — not yet built in this project, so
 * `READINESS_PROVIDER` is `@Optional()`: HTTP works standalone TODAY (an
 * honest "nothing registered to check yet" result) and picks up real
 * aggregated state the moment a Health module provides one, with zero changes
 * needed here. See SPEC-ERRATA.md E-H1.
 *
 * `/health/live`: liveness — "is the process itself running at all," answered
 * unconditionally and immediately, never dependent on any other module.
 * `/health/ready`: readiness — "can this instance actually serve traffic,"
 * delegated entirely to whatever `READINESS_PROVIDER` reports.
 */
import { Controller, Get, HttpCode, Inject, Optional, Res, SetMetadata } from '@nestjs/common';
import type { Response } from 'express';
import { READINESS_PROVIDER } from '../http.tokens';
import type { ReadinessProvider, ReadinessResult } from './readiness-provider.port';

const NO_PROVIDER_RESULT: ReadinessResult = { status: 'healthy', components: {} };

/**
 * Marked public for Security's global `AuthGuard` (Security spec §5.1: default-deny, opt out
 * with `@Public()`). HTTP cannot import Security (Layer 1 sibling), so it sets the same plain
 * metadata key `@Public()` sets — an orchestrator's probe carries no bearer token, and a 401
 * here would restart every healthy pod. See Security SPEC-ERRATA E-S20.
 */
@SetMetadata('security:isPublic', true)
@Controller('health')
export class HealthController {
  constructor(@Optional() @Inject(READINESS_PROVIDER) private readonly readiness?: ReadinessProvider) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    const result = this.readiness ? await this.readiness.getReadiness() : NO_PROVIDER_RESULT;
    res.status(result.status === 'healthy' ? 200 : 503).json(result);
  }
}
