import { defineStore } from "pinia"
import { ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"

/**
 * Cache of commentary (purport / prose-chapter / letter) citations streamed
 * from the chat server via the `commentary` SSE action event (see
 * `runChatTurn` → `commentary-payload`). Keyed by the integer `ref` that the
 * `[commentary:N]` marker carries, so `CommentaryCard.vue` renders the quote
 * as a card (text + author + reference) — the audio-citation shape — without
 * re-fetching, and a chip upgrades to the card the moment the payload lands.
 *
 * Mirrors `useCiteTranscriptStore`: the client holds no commentary text
 * locally, so this server-pushed cache is the only source. Misses (payload
 * not delivered / LRU-evicted / pre-feature history) degrade to the marker
 * rendering nothing.
 *
 * Persistence goes through the `IPreferences` port; the whole cache lives
 * under one key, LRU-bounded to MAX_ENTRIES.
 */

const STORAGE_KEY = "lectorium.commentary_body_cache.v1"
const MAX_ENTRIES = 200

/** Decoded commentary citation exposed to the card. `text` is the shown
 *  quote (native, machine-translated, or en-preferred). When `mt` is true,
 *  `textOriginal` carries the verbatim source so the card can toggle. */
export interface CommentaryBodyEntry {
  readonly text: string
  readonly authorName: string
  /** Human address / reference, e.g. "БГ 2.13". */
  readonly addrLabel: string
  /** Source kind: "commentary" | "prose_chapter" | "letter". */
  readonly commentaryKind: string
  /** True when `text` is a machine translation into the answer language. */
  readonly mt?: boolean
  /** Verbatim source-language quote, present only when `mt` is true. */
  readonly textOriginal?: string
}

interface StoredEntry extends CommentaryBodyEntry {
  readonly touchedAt: number
}

export const useCommentaryBodyStore = defineStore("commentaryBody", () => {
  const app = useLectorium()

  const entries = ref<Map<number, StoredEntry>>(new Map())
  let hydrated = false
  let hydrationPromise: Promise<void> | null = null
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  async function hydrate(): Promise<void> {
    if (hydrated) return
    if (hydrationPromise) return hydrationPromise
    hydrationPromise = (async () => {
      try {
        const raw = await app.preferences.get(STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, StoredEntry>
          const map = new Map<number, StoredEntry>()
          for (const [k, v] of Object.entries(parsed)) {
            const n = Number(k)
            if (Number.isFinite(n) && v && typeof v === "object") map.set(n, v)
          }
          entries.value = map
        }
      } catch (err) {
        // Corrupt cache — wipe rather than crash. The server re-emits the
        // commentary payload on the next cite, so a cold cache self-heals.
        console.warn("[commentaryBodyStore] hydrate failed, resetting:", err)
        entries.value = new Map()
      } finally {
        hydrated = true
      }
    })()
    return hydrationPromise
  }

  function persistSoon(): void {
    if (persistTimer !== null) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persistNow()
    }, 250)
  }

  async function persistNow(): Promise<void> {
    const obj: Record<string, StoredEntry> = {}
    for (const [k, v] of entries.value.entries()) obj[String(k)] = v
    try {
      await app.preferences.set(STORAGE_KEY, JSON.stringify(obj))
    } catch (err) {
      console.warn("[commentaryBodyStore] persist failed:", err)
    }
  }

  function set(ref: number, body: CommentaryBodyEntry): void {
    const next = new Map(entries.value)
    next.set(ref, { ...body, touchedAt: Date.now() })
    // LRU-style eviction: drop the oldest-touched entries past the cap so
    // the on-device blob stays bounded and hydrate stays fast.
    if (next.size > MAX_ENTRIES) {
      const sorted = [...next.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)
      while (sorted.length > MAX_ENTRIES) {
        const oldest = sorted.shift()
        if (oldest) next.delete(oldest[0])
      }
    }
    entries.value = next
    persistSoon()
  }

  /** Full entry for the card (text + author + reference + mt/original).
   *  Null on a cache miss. */
  function get(ref: number): CommentaryBodyEntry | null {
    const e = entries.value.get(ref)
    if (!e) return null
    return {
      text: e.text,
      authorName: e.authorName,
      addrLabel: e.addrLabel,
      commentaryKind: e.commentaryKind,
      ...(e.mt ? { mt: true } : {}),
      ...(e.textOriginal ? { textOriginal: e.textOriginal } : {}),
    }
  }

  return { hydrate, set, get }
})
