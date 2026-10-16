/** `ReplayProtectionStore` — Security spec §18.2. */
export interface ReplayProtectionStore {
  /**
   * `true` = this nonce was seen before (REPLAY — reject). `false` = first sighting; it is
   * now marked for `ttlSeconds`. MUST be atomic (check-and-set), or two concurrent replays
   * could both pass.
   */
  checkAndMark(nonce: string, ttlSeconds: number): Promise<boolean>;
  /** Testing only. */
  clear(nonce: string): Promise<void>;
}
