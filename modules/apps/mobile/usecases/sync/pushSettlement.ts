import type { OutboxEntry } from "@lib/domain/ports/outboxRepository.js"
import { compareHlcString, type SyncDocRef } from "@lib/domain"

/** `\x00`-joined ref key — the separator can't occur in a collection name. */
export function refKey(collection: string, docId: string): string {
  return `${collection}\x00${docId}`
}

/** Highest-id pending entry for a `(collection, doc)` ref — the local side of
 *  a conflict re-merge. */
export function latestPendingForKey(
  pending: readonly OutboxEntry[],
  key: string
): OutboxEntry | undefined {
  let best: OutboxEntry | undefined
  for (const entry of pending) {
    if (refKey(entry.collection, entry.docId) !== key) continue
    if (!best || entry.id > best.id) best = entry
  }
  return best
}

/** The lexicographically-higher of two HLC strings; `a` may be null. */
export function higherHlc(a: string | null, b: string): string {
  if (a === null) return b
  return compareHlcString(a, b) >= 0 ? a : b
}

export interface Settlement {
  /** Rows the server applied — their HLC becomes the doc's server master. */
  readonly applied: readonly OutboxEntry[]
  /** Rows to mark sent: applied, plus conflicted ones the re-merge supersedes,
   *  which would otherwise be re-pushed forever. */
  readonly sentIds: readonly number[]
  /** The documents this round acknowledged — the scope of compaction. */
  readonly sentDocs: readonly SyncDocRef[]
  /**
   * How far the read watermark may advance. It gates reads, so it may only
   * cover a CONTIGUOUS run of handled rows (`pending` is id-ascending): past a
   * row left pending, that row would be retired unpushed.
   */
  readonly maxSentId: number
}

/** Sort one push response's outcome over the rows that were sent. A row that
 *  is neither applied nor conflicted (which should not happen) is left pending
 *  for the next run. */
export function settlePushedRows(
  pending: readonly OutboxEntry[],
  appliedKeys: ReadonlySet<string>,
  conflictKeys: ReadonlySet<string>
): Settlement {
  const applied: OutboxEntry[] = []
  const sentIds: number[] = []
  const sentDocs = new Map<string, SyncDocRef>()
  let maxSentId = 0
  let stalled = false

  for (const entry of pending) {
    const key = refKey(entry.collection, entry.docId)
    const wasApplied = appliedKeys.has(key)
    if (!wasApplied && !conflictKeys.has(key)) {
      stalled = true
      continue
    }
    if (wasApplied) applied.push(entry)
    sentIds.push(entry.id)
    sentDocs.set(key, { collection: entry.collection, docId: entry.docId })
    if (!stalled) maxSentId = entry.id
  }

  return { applied, sentIds, sentDocs: [...sentDocs.values()], maxSentId }
}
