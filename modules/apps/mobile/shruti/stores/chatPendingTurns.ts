import type { IPreferences } from "@ports/app/index.js"

/** A tiny per-in-flight-turn record persisted so a dropped live stream can be
 *  recovered after an app kill (poll the server + replay the buffered turn). */
export interface PendingTurn {
  readonly assistantMessageId: string
  readonly sessionId: string
  readonly createdAt: number
}

const PENDING_TURNS_KEY = "chat:pending_turns"

/**
 * Preferences-backed persistence for the in-flight-turn records, factored out
 * of `useChatStore` so the store keeps only the resume *orchestration*. Writes
 * are best-effort: a failed persist just weakens kill-recovery, it never
 * breaks the live turn. Pure I/O over the `IPreferences` port — unit-testable
 * with a fake.
 */
export function createPendingTurnStore(preferences: IPreferences): {
  read: () => Promise<PendingTurn[]>
  add: (assistantMessageId: string, sessionId: string) => Promise<void>
  remove: (assistantMessageId: string) => Promise<void>
  clear: () => Promise<void>
} {
  async function read(): Promise<PendingTurn[]> {
    try {
      const raw = await preferences.get(PENDING_TURNS_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as PendingTurn[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async function write(list: PendingTurn[]): Promise<void> {
    try {
      if (list.length === 0) await preferences.remove(PENDING_TURNS_KEY)
      else await preferences.set(PENDING_TURNS_KEY, JSON.stringify(list))
    } catch {
      // best-effort — a failed persist just means weaker kill-recovery
    }
  }

  async function add(assistantMessageId: string, sessionId: string): Promise<void> {
    const list = await read()
    if (list.some((p) => p.assistantMessageId === assistantMessageId)) return
    list.push({ assistantMessageId, sessionId, createdAt: Date.now() })
    await write(list)
  }

  async function remove(assistantMessageId: string): Promise<void> {
    const list = await read()
    const next = list.filter((p) => p.assistantMessageId !== assistantMessageId)
    if (next.length !== list.length) await write(next)
  }

  /** Drop every record — the previous identity's in-flight turns mean nothing
   *  under a new token, and re-polling them 404s forever. */
  async function clear(): Promise<void> {
    await write([])
  }

  return { read, add, remove, clear }
}
