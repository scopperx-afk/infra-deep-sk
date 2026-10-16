/**
 * Transport abstraction — Logger spec §18. The Core Logger is not coupled to
 * any specific transport; Console (§19) ships now, File/HTTP/Sentry (§20, §21,
 * §24) are adapters added later, one at a time (§42) — see README "Not built".
 */
import type { LogEntry } from '../logger.port';

export interface TransportHealth {
  healthy: boolean;
  message?: string;
}

export interface LogTransport {
  readonly name: string;
  write(entry: LogEntry): Promise<void> | void;
  health(): TransportHealth;
  close(): Promise<void>;
}

/** §25's table — fixed per transport TYPE, not runtime-determined, so it travels
 *  alongside the transport instance rather than being part of its own health() call. */
export interface TransportRegistration {
  transport: LogTransport;
  critical: boolean;
}
