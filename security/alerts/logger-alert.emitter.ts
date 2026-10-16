/**
 * `LoggerAlertEmitter` — the default `SecurityAlertEmitter`: writes to Logger at
 * `warn` (low/medium), `error` (high) or `fatal` (critical).
 *
 * `emit()` is total — a malformed alert or a failing logger is swallowed (it must never turn
 * a security event into a request failure). Logger's own redactor handles sensitive field
 * names inside `details`; this class additionally never logs anything but the alert itself.
 */
import { Inject, Injectable } from '@nestjs/common';
import { LOGGER_SERVICE, type ILogger } from '../../logger';
import type { AlertSeverity, SecurityAlert, SecurityAlertEmitter } from './security-alert.port';

@Injectable()
export class LoggerAlertEmitter implements SecurityAlertEmitter {
  constructor(@Inject(LOGGER_SERVICE) private readonly logger: ILogger) {}

  async emit(alert: SecurityAlert): Promise<void> {
    try {
      const metadata = {
        alertType: alert.type,
        severity: alert.severity,
        principalId: alert.principalId,
        ip: alert.ip,
        occurredAt: alert.occurredAt,
        details: alert.details,
      };
      const message = `security.alert.${alert.type}`;
      const severity: AlertSeverity = alert.severity;
      if (severity === 'critical') this.logger.fatal(message, undefined, metadata);
      else if (severity === 'high') this.logger.error(message, undefined, metadata);
      else this.logger.warn(message, metadata);
    } catch {
      /* never throws to the caller (§17.2) */
    }
  }
}
