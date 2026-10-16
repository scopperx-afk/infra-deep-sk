/**
 * `SecurityAlertEmitter` — Security spec §17.2.
 *
 * Fire-and-forget: `emit()` NEVER throws and never blocks its caller. The default
 * (`LoggerAlertEmitter`) writes to Logger; a production override at the composition root
 * fans out to Slack / PagerDuty / Redis Pub-Sub via `SecurityModule.forRoot({ alertEmitter })`.
 */
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SecurityAlert {
  readonly type: string;
  readonly severity: AlertSeverity;
  readonly principalId?: string;
  readonly ip?: string;
  readonly details: Record<string, unknown>;
  /** ISO-8601. */
  readonly occurredAt: string;
}

export interface SecurityAlertEmitter {
  emit(alert: SecurityAlert): Promise<void>;
}
