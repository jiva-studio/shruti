import { ref, type Ref } from "vue"
import type { IPreferences } from "@ports/app/index.js"

const UNREAD_ANSWERS_KEY = "chat:unread_answers"
const LAST_SEEN_KEY = "chat:last_seen_message"

export interface ChatReadState {
  /** Sessions showing a dot: an unseen proactive row, or an answer that landed while the user was away. */
  unseenSessionIds: Ref<ReadonlySet<string>>
  refreshUnseen: (
    proactiveIds: readonly string[],
    liveSessionIds: ReadonlySet<string>
  ) => Promise<void>
  markAnswerUnread: (sessionId: string) => Promise<void>
  clearAnswerUnread: (sessionId: string) => Promise<void>
  forgetUnseen: (sessionId: string) => void
  clearAllUnseen: () => void
  /** Wipes both preference keys — the badge and the anchors outlive a table wipe otherwise. */
  clearAll: () => Promise<void>
  getLastSeenMessageId: (sessionId: string) => Promise<string | null>
  markSessionSeen: (sessionId: string, messageId: string) => Promise<void>
  clearLastSeen: (sessionId: string) => Promise<void>
}

/**
 * What the user has and hasn't seen: the per-session unread dot, and the id of
 * the last message read in each session (the scroll anchor on reopen).
 *
 * Every write is best-effort — a failed persist only weakens the badge or the
 * anchor across restarts, and must never sink the caller.
 */
export function useChatReadState(preferences: IPreferences): ChatReadState {
  const unseenSessionIds = ref<ReadonlySet<string>>(new Set())

  async function readUnreadAnswers(): Promise<string[]> {
    try {
      const raw = await preferences.get(UNREAD_ANSWERS_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as string[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async function writeUnreadAnswers(ids: string[]): Promise<void> {
    try {
      if (ids.length === 0) await preferences.remove(UNREAD_ANSWERS_KEY)
      else await preferences.set(UNREAD_ANSWERS_KEY, JSON.stringify(ids))
    } catch {
      // best-effort — a failed persist just means weaker cross-restart badge
    }
  }

  /**
   * Rebuild the dotted set from the proactive rows plus the persisted
   * answered-while-away ids, keeping only ids that still have a conversation:
   * an id whose session is gone has nothing left to open and so nothing left
   * to clear it.
   */
  async function refreshUnseen(
    proactiveIds: readonly string[],
    liveSessionIds: ReadonlySet<string>
  ): Promise<void> {
    const persisted = await readUnreadAnswers()
    const answers = persisted.filter((id) => liveSessionIds.has(id))
    if (answers.length !== persisted.length) await writeUnreadAnswers(answers)
    unseenSessionIds.value = new Set([...proactiveIds, ...answers])
  }

  /** Drops the dot on the spot, without waiting for a refresh roundtrip. */
  function forgetUnseen(sessionId: string): void {
    if (!unseenSessionIds.value.has(sessionId)) return
    const next = new Set(unseenSessionIds.value)
    next.delete(sessionId)
    unseenSessionIds.value = next
  }

  function clearAllUnseen(): void {
    unseenSessionIds.value = new Set()
  }

  async function clearAll(): Promise<void> {
    clearAllUnseen()
    await writeUnreadAnswers([])
    try {
      await preferences.remove(LAST_SEEN_KEY)
    } catch {
      // best-effort — a stale anchor map only affects scroll position
    }
  }

  async function markAnswerUnread(sessionId: string): Promise<void> {
    if (!unseenSessionIds.value.has(sessionId)) {
      const next = new Set(unseenSessionIds.value)
      next.add(sessionId)
      unseenSessionIds.value = next
    }
    const ids = await readUnreadAnswers()
    if (!ids.includes(sessionId)) {
      ids.push(sessionId)
      await writeUnreadAnswers(ids)
    }
  }

  async function clearAnswerUnread(sessionId: string): Promise<void> {
    const ids = await readUnreadAnswers()
    const next = ids.filter((x) => x !== sessionId)
    if (next.length !== ids.length) await writeUnreadAnswers(next)
  }

  async function readLastSeen(): Promise<Record<string, string>> {
    try {
      const raw = await preferences.get(LAST_SEEN_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as Record<string, string>
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }

  /** Read before `openSession` to decide the scroll anchor; null when never opened. */
  async function getLastSeenMessageId(sessionId: string): Promise<string | null> {
    return (await readLastSeen())[sessionId] ?? null
  }

  /**
   * Record `messageId` as the latest message seen in the session. The view
   * passes only non-streaming messages, so a placeholder sharing the final
   * answer's id never counts as read when the user leaves mid-turn.
   */
  async function markSessionSeen(sessionId: string, messageId: string): Promise<void> {
    const map = await readLastSeen()
    if (map[sessionId] === messageId) return
    map[sessionId] = messageId
    try {
      await preferences.set(LAST_SEEN_KEY, JSON.stringify(map))
    } catch {
      // best-effort — a failed persist just means weaker scroll anchoring
    }
  }

  /** Forget a deleted session's anchor so the map doesn't grow an entry per dead conversation. */
  async function clearLastSeen(sessionId: string): Promise<void> {
    const map = await readLastSeen()
    if (map[sessionId] === undefined) return
    delete map[sessionId]
    try {
      if (Object.keys(map).length === 0) await preferences.remove(LAST_SEEN_KEY)
      else await preferences.set(LAST_SEEN_KEY, JSON.stringify(map))
    } catch {
      // best-effort — a failed write just leaves a stale anchor behind
    }
  }

  return {
    unseenSessionIds,
    refreshUnseen,
    markAnswerUnread,
    clearAnswerUnread,
    forgetUnseen,
    clearAllUnseen,
    clearAll,
    getLastSeenMessageId,
    markSessionSeen,
    clearLastSeen,
  }
}
