import { readMarker } from "./readMarker.js"
import type { ISyncMarkerStore } from "./syncEnginePorts.js"

/** Device-local floor marking where the pull started passing chat changes over
 *  because "Sync chats" was off. The pull cursor is global and advances
 *  across skipped rows, so without it re-enabling the toggle could never bring
 *  those conversations back — `profile.changes` keeps them, but nothing would
 *  ever ask for them again. Absent ⇒ no outstanding gap. */
const CHAT_GAP_KEY = "sync.chatGapCursor"

export interface ChatGapCursor {
  read: () => Promise<number | null>
  write: (cursor: number | null) => Promise<void>
}

export function createChatGapCursor(markers: ISyncMarkerStore): ChatGapCursor {
  /** The outstanding chat gap, or `null` when there is none. */
  async function read(): Promise<number | null> {
    const raw = await readMarker(markers, CHAT_GAP_KEY)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }

  /** Persist the gap floor; `null` clears it (a full re-pull has closed it). */
  async function write(cursor: number | null): Promise<void> {
    try {
      if (cursor === null) await markers.remove(CHAT_GAP_KEY)
      else await markers.set(CHAT_GAP_KEY, String(cursor))
    } catch {
      // Best-effort: a lost write re-pulls the same span next cycle, which the
      // apply path absorbs as an idempotent LWW no-op.
    }
  }

  return { read, write }
}
