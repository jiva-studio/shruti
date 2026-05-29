import { defineStore } from "pinia"
import { ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"

/**
 * Cache of citation transcript snippets streamed from the chat server
 * via the `cite_transcript` SSE event (see `runChatTurn` →
 * `cite-transcript-payload`). Keyed by `${trackId}|${startMs}-${endMs}`
 * so `CitationCard.vue` can render the full quote block (player + text +
 * attributes) without re-fetching, and so a chip upgrades to the card
 * the moment the payload lands — even after the marker already streamed.
 *
 * Mirrors `useVerseBodyStore`: the client doesn't hold all transcripts
 * locally, so this server-pushed cache is the only text source. Misses
 * (payload not delivered / LRU-evicted / pre-feature history) degrade to
 * the small citation chip.
 *
 * Persistence goes through the `IPreferences` port; the whole cache
 * lives under one key, LRU-bounded to MAX_ENTRIES.
 */

const STORAGE_KEY = "lectorium.cite_transcript_cache.v1"
const MAX_ENTRIES = 200

interface StoredEntry {
  readonly text: string
  readonly touchedAt: number
}

function makeKey(trackId: string, startMs: number, endMs: number): string {
  return `${trackId}|${startMs}-${endMs}`
}

export const useCiteTranscriptStore = defineStore("citeTranscript", () => {
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
        // Corrupt cache — wipe rather than crash. The server re-emits
        // cite_transcript on the next cite, so a cold cache self-heals
        // within one round-trip.
        console.warn("[citeTranscriptStore] hydrate failed, resetting:", err)
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
      console.warn("[citeTranscriptStore] persist failed:", err)
    }
  }

  function set(trackId: string, startMs: number, endMs: number, text: string): void {
    const key = makeKey(trackId, startMs, endMs)
    const next = new Map(entries.value)
    next.set(key, { text, touchedAt: Date.now() })
    // LRU-style eviction: drop the oldest-touched entries past the cap
    // so the on-device blob stays bounded and hydrate stays fast.
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

  function get(trackId: string, startMs: number, endMs: number): string | null {
    const e = entries.value.get(makeKey(trackId, startMs, endMs))
    return e ? e.text : null
  }

  return { hydrate, set, get }
})
