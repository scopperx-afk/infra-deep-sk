/** `AnomalyDetector` — Security spec §17.3. */
export interface AnomalyDetector {
  /** Records an event for a principal. `true` = an anomaly threshold was crossed. */
  record(principalId: string, event: string, metadata?: Record<string, unknown>): Promise<boolean>;
  reset(principalId: string): Promise<void>;
}
