/**
 * Default `CacheInvalidationBus`: process-local fan-out. Enough for a single instance (and
 * for tests); across instances an invalidation only reaches subscribers in the SAME process,
 * which is exactly why the real implementation is Redis pub/sub (Cache module). A handler
 * that throws or rejects never affects the publisher or the other handlers.
 */
import type { CacheInvalidationBus } from './cache-invalidation-bus.port';

type Handler = (payload: unknown) => void | Promise<void>;

export class InMemoryCacheInvalidationBus implements CacheInvalidationBus {
  private readonly handlers = new Map<string, Set<Handler>>();

  async publish(channel: string, payload: unknown): Promise<void> {
    const subscribers = this.handlers.get(channel);
    if (!subscribers) return;
    await Promise.allSettled([...subscribers].map(async (handler) => handler(payload)));
  }

  async subscribe(channel: string, handler: Handler): Promise<() => void> {
    let subscribers = this.handlers.get(channel);
    if (!subscribers) this.handlers.set(channel, (subscribers = new Set()));
    subscribers.add(handler);
    return (): void => {
      const current = this.handlers.get(channel);
      current?.delete(handler);
      if (current && current.size === 0) this.handlers.delete(channel);
    };
  }
}
