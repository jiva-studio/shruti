import type { PushItem, SyncOp } from "@lib/contracts"

/** A local change waiting to be pushed, whichever store queued it. */
export interface PendingChange {
  readonly collection: string
  readonly docId: string
  readonly op: SyncOp
  readonly data: unknown
  readonly hlc: string
}

/**
 * The wire row for one pending change. `baseHlc` is the server version the
 * change was made against (`""` for a document the server has not seen): the
 * server applies the change only if its master still carries it. A delete
 * sends no `data`.
 */
export function toPushItem(change: PendingChange, baseHlc: string): PushItem {
  return {
    collection: change.collection,
    doc_id: change.docId,
    op: change.op,
    data: change.op === "delete" ? undefined : change.data,
    hlc: change.hlc,
    base_hlc: baseHlc,
  }
}
