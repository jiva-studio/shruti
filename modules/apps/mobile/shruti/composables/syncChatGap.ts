import type { useShruti } from "@shruti/shruti.js"

type Shruti = ReturnType<typeof useShruti>

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

export function createChatGapCursor(deps: Pick<Shruti, "preferences">): ChatGapCursor {
  /** The outstanding chat gap, or `null` when there is none. */
  async function read(): Promise<number | null> {
    const raw = await deps.preferences.get(CHAT_GAP_KEY).catch(() => null)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }

  /** Persist the gap floor; `null` clears it (a full re-pull has closed it). */
  async function write(cursor: number | null): Promise<void> {
    try {
      if (cursor === null) await deps.preferences.remove(CHAT_GAP_KEY)
      else await deps.preferences.set(CHAT_GAP_KEY, String(cursor))
    } catch {
      // Best-effort: a lost write re-pulls the same span next cycle, which the
      // apply path absorbs as an idempotent LWW no-op.
    }
  }

  return { read, write }
}
