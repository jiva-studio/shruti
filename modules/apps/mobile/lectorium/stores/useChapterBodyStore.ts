import { defineStore } from "pinia"
import { ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"

/**
 * Cache of chapter-location bodies streamed from the chat server via the
 * `chapter_payload` SSE event (the locate intent's answer to "where in
 * scripture is this?"). Keyed by `${sourceId}|${regionToken}` so
 * `ChapterCard.vue` can render the canto/chapter list without re-fetching
 * when the same region is cited in a future turn or after a restart.
 *
 * Mirrors `useVerseBodyStore`: one Preferences key, LRU-bounded, debounced
 * persist. The chapter TITLES come from the server payload (read verbatim
 * from `library_titles`) — never composed on-device.
 */

const STORAGE_KEY = "lectorium.chapter_body_cache.v1"
const MAX_ENTRIES = 200

export interface ChapterEntry {
  readonly tokens: string
  readonly title: string
}

export interface ChapterBody {
  readonly regionLabel: string
  readonly chapters: readonly ChapterEntry[]
}

interface StoredEntry extends ChapterBody {
  readonly touchedAt: number
}

function makeKey(sourceId: string, regionToken: string): string {
  return `${sourceId}|${regionToken}`
}

export const useChapterBodyStore = defineStore("chapterBody", () => {
  const app = useLectorium()

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
        // Corrupt cache — wipe rather than crash; the server re-emits
        // chapter_payload on the next locate turn, so it self-heals.
        console.warn("[chapterBodyStore] hydrate failed, resetting:", err)
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
      console.warn("[chapterBodyStore] persist failed:", err)
    }
  }

  function set(sourceId: string, regionToken: string, body: ChapterBody): void {
    const key = makeKey(sourceId, regionToken)
    const next = new Map(entries.value)
    next.set(key, { ...body, touchedAt: Date.now() })
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

  function get(sourceId: string, regionToken: string): ChapterBody | null {
    const e = entries.value.get(makeKey(sourceId, regionToken))
    if (!e) return null
    return { regionLabel: e.regionLabel, chapters: e.chapters }
  }

  return { hydrate, set, get }
})
