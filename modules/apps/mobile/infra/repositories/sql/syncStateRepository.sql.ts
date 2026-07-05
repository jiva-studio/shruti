import type { IDatabase } from "@ports/app/index.js"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"
import type { SyncStateRow } from "@lib/persistence/user"

/**
 * SQL adapter over the per-device `sync_state` row (013 migration)
 * implementing {@link ISyncStateRepository}.
 *
 * The row is keyed by this device's stable id, resolved lazily (and memoized)
 * through the injected provider — the same `Device.getId()` source that stamps
 * HLCs and the pull `X-Device-Id` header, so all three agree on the device
 * identity. A missing row reads as all-zeros; every setter UPSERTs.
 *
 * Writes use raw `db.execute` — the engine's reentrant unit-of-work owns the
 * enclosing transaction and its single persist.
 */
export function createSqlSyncStateRepository(
  db: IDatabase,
  getDeviceId: () => Promise<string>
): ISyncStateRepository {
  let cachedDeviceId: string | null = null
  async function deviceId(): Promise<string> {
    if (cachedDeviceId === null) cachedDeviceId = await getDeviceId()
    return cachedDeviceId
  }

  async function readColumn(column: keyof SyncStateRow): Promise<number> {
    const id = await deviceId()
    const rows = await db.query<Record<string, number>>(
      `SELECT ${column} AS value FROM sync_state WHERE device_id = ?`,
      [id]
    )
    return rows.length > 0 ? Number(rows[0]!.value) : 0
  }

  async function writeColumn(column: keyof SyncStateRow, value: number): Promise<void> {
    const id = await deviceId()
    // Ensure the device row exists (no-op if it already does), then update the
    // one column. Two statements is simpler than an UPSERT that has to restate
    // the column both in VALUES and in the conflict clause.
    await db.execute(
      `INSERT OR IGNORE INTO sync_state
         (device_id, pull_cursor, acked_seq, pushed_outbox_id, updated_at)
       VALUES (?, 0, 0, 0, ?)`,
      [id, Date.now()]
    )
    await db.execute(`UPDATE sync_state SET ${column} = ?, updated_at = ? WHERE device_id = ?`, [
      value,
      Date.now(),
      id,
    ])
  }

  return {
    getDeviceId: deviceId,
    getPullCursor: () => readColumn("pull_cursor"),
    setPullCursor: (cursor) => writeColumn("pull_cursor", cursor),
    getAckedSeq: () => readColumn("acked_seq"),
    setAckedSeq: (seq) => writeColumn("acked_seq", seq),
    getPushedOutboxId: () => readColumn("pushed_outbox_id"),
    setPushedOutboxId: (id) => writeColumn("pushed_outbox_id", id),
  }
}
