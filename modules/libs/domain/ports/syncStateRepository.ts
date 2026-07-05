/**
 * Read/write port over the per-device `sync_state` row (013 migration): the
 * pull cursor, the cursor acknowledged back to the server for compaction, and
 * the highest local `outbox.id` confirmed pushed. Keyed by this device's
 * stable id, which the adapter resolves from the same source that stamps HLCs
 * and the pull `X-Device-Id` header.
 *
 * Domain port — the SQL implementation lives in `@infra/repositories/sql`.
 * Mutations join the caller's reentrant unit-of-work.
 */
export interface ISyncStateRepository {
  /** This device's stable id (the HLC tiebreak / pull echo-suppression key). */
  getDeviceId(): Promise<string>

  /** Highest server `global_seq` this device has pulled + applied. Starts 0. */
  getPullCursor(): Promise<number>
  setPullCursor(cursor: number): Promise<void>

  /** Highest `global_seq` acknowledged to the server (drives compaction). */
  getAckedSeq(): Promise<number>
  setAckedSeq(seq: number): Promise<void>

  /** Highest local `outbox.id` confirmed pushed. */
  getPushedOutboxId(): Promise<number>
  setPushedOutboxId(id: number): Promise<void>
}
