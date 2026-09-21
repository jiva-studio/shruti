import { ref, type Ref } from "vue"
import type { IPreferences } from "@ports/app/index.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { parseChatUsageSnapshot, type ChatUsageSnapshot } from "./chatUsageSnapshot.js"

const USAGE_KEY_PREFIX = "chat_usage:"

/** The parts of a `rate_limited` turn error the chip reads. */
export interface RateLimitUsage {
  /** Device-clock deadline the lockout runs to. */
  retryAfterAt: number
  keyType: string | undefined
  current: number | undefined
  limit: number | undefined
  resetsAtEpoch: number | undefined
}

export interface ChatUsageChip {
  snapshot: Ref<ChatUsageSnapshot | null>
  hydrate: (qid: string) => Promise<void>
  record: (usage: { current: number; limit: number; resetsAtEpoch: number }) => void
  recordFromRateLimit: (info: RateLimitUsage) => void
}

/**
 * The daily usage counter above the composer, persisted per `quota_id`.
 *
 * It is a read-only display of a counter the server owns, so a stale snapshot
 * can trap nobody — unlike the compose lockout, which stays in memory.
 */
export function useChatUsageChip(preferences: IPreferences): ChatUsageChip {
  const snapshot = ref<ChatUsageSnapshot | null>(null)

  // Keyed by quota_id so separate identities don't bleed into each other; an
  // empty qid means in-memory only.
  function usageKey(qid: string): string {
    return `${USAGE_KEY_PREFIX}${qid}`
  }

  async function hydrate(qid: string): Promise<void> {
    if (!qid) {
      snapshot.value = null
      return
    }
    const key = usageKey(qid)
    try {
      const raw = await preferences.get(key)
      if (raw === null) {
        snapshot.value = null
        return
      }
      const parsed = parseChatUsageSnapshot(raw, Date.now())
      snapshot.value = parsed
      if (!parsed) await preferences.remove(key)
    } catch (e) {
      console.warn("[chat] failed to hydrate chat usage", e)
      snapshot.value = null
    }
  }

  /** Fire-and-forget: a storage hiccup must not sink the streaming turn. */
  function persist(qid: string): void {
    if (!qid) return
    const snap = snapshot.value
    if (snap === null) {
      void preferences.remove(usageKey(qid)).catch((e) => {
        console.warn("[chat] failed to clear chat usage key", e)
      })
      return
    }
    void preferences.set(usageKey(qid), JSON.stringify(snap)).catch((e) => {
      console.warn("[chat] failed to persist chat usage", e)
    })
  }

  /** Frame from a successful turn; it carries no `Retry-After`, so the server epoch is the expiry. */
  function record(usage: { current: number; limit: number; resetsAtEpoch: number }): void {
    snapshot.value = { ...usage, expiresAtMs: usage.resetsAtEpoch * 1000 }
    persist(useAuthStore().quotaId)
  }

  // Only a USER-bucket 429 says anything about this user's quota: an IP-bucket
  // one means a CGNAT peer drained the per-IP cap, and the chip would mislead.
  function recordFromRateLimit(info: RateLimitUsage): void {
    if (
      info.keyType !== "user" ||
      typeof info.current !== "number" ||
      typeof info.limit !== "number" ||
      info.limit <= 0
    ) {
      return
    }
    const resetsAtEpoch =
      typeof info.resetsAtEpoch === "number" && info.resetsAtEpoch > 0
        ? info.resetsAtEpoch
        : Math.floor(info.retryAfterAt / 1000)
    snapshot.value = {
      current: info.current,
      limit: info.limit,
      resetsAtEpoch,
      // Device-measured whenever the server sent a `Retry-After` — the one
      // expiry a skewed clock cannot stretch.
      expiresAtMs: info.retryAfterAt,
    }
    persist(useAuthStore().quotaId)
  }

  return { snapshot, hydrate, record, recordFromRateLimit }
}
