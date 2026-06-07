import { defineStore } from "pinia"
import { ref } from "vue"
import { useShruti } from "@shruti/shruti.js"

/**
 * Cache of verse bodies streamed from the chat server via the
 * `verse_payload` SSE event. Keyed by `${sourceId}|${tokens}` so the
 * `VerseCard.vue` component can render the full block (sanskrit + IAST
 * + translation) without re-fetching from the server when the same
 * verse is cited in a future turn or after the app restarts.
 *
 * Persistence goes through the `IPreferences` port (NSUserDefaults /
 * SharedPreferences on native, IndexedDB on web). The whole cache lives
 * under one Preferences key and is bounded to MAX_ENTRIES so it can't
 * grow unboundedly across a long-running install.
 */

const STORAGE_KEY = "shruti.verse_body_cache.v1"
const MAX_ENTRIES = 200

export interface VerseBody {
  readonly addrLabel: string
  readonly sanskrit: string
  readonly transliteration: string
  readonly translation: { readonly [lang: string]: string }
  /** Full public URL of the Sanskrit recitation, when the library has
   *  audio for this verse. Drives the play button on VerseCard. */
  readonly audioUrl?: string
}

interface StoredEntry extends VerseBody {
  readonly touchedAt: number
}

function makeKey(sourceId: string, tokens: string): string {
  return `${sourceId}|${tokens}`
}

export const useVerseBodyStore = defineStore("verseBody", () => {
  const app = useShruti()

  const entries = ref<Map<string, StoredEntry>>(new Map())
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
          const map = new Map<string, StoredEntry>()
          for (const [k, v] of Object.entries(parsed)) {
            if (v && typeof v === "object") map.set(k, v)
          }
          entries.value = map
        }
      } catch (err) {
        // Corrupt cache — wipe it rather than crashing the app on next
        // chat turn. The server re-emits verse_payload on the next
        // cite, so a cold cache self-heals within one round-trip.
        console.warn("[verseBodyStore] hydrate failed, resetting:", err)
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
    for (const [k, v] of entries.value.entries()) obj[k] = v
    try {
      await app.preferences.set(STORAGE_KEY, JSON.stringify(obj))
    } catch (err) {
      console.warn("[verseBodyStore] persist failed:", err)
    }
  }

  function set(sourceId: string, tokens: string, body: VerseBody): void {
    const key = makeKey(sourceId, tokens)
    const next = new Map(entries.value)
    next.set(key, { ...body, touchedAt: Date.now() })
    // LRU-style eviction: when the cache overflows MAX_ENTRIES, drop
    // the oldest-touched entries. Keeps the on-device blob bounded so
    // the JSON parse on hydrate stays fast.
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

  function get(sourceId: string, tokens: string): VerseBody | null {
    const e = entries.value.get(makeKey(sourceId, tokens))
    if (!e) return null
    return {
      addrLabel: e.addrLabel,
      sanskrit: e.sanskrit,
      transliteration: e.transliteration,
      translation: e.translation,
      audioUrl: e.audioUrl,
    }
  }

  return { hydrate, set, get }
})
