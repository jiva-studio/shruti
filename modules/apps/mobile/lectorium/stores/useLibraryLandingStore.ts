import { defineStore } from "pinia"
import { ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useRecommendationsStore } from "@lectorium/stores/useRecommendationsStore.js"
import { searchAndFilterTracks } from "@usecases/discovery/searchAndFilterTracks.js"
import type { Track } from "@lib/domain/track.js"
import type { LanguageCode } from "@lib/domain/core.js"

/** One collection card within a group. */
export interface GroupCollection {
  readonly id: string
  readonly name: string
  readonly coverUrl?: string
  readonly description?: string
}

/** A named group (shelf) with its ordered collections, ready to render. */
export interface CollectionGroupView {
  readonly id: string
  readonly name: string
  readonly collections: readonly GroupCollection[]
}

// The "All lectures" preview draws a random sample from this pool; oversized so
// a reshuffle on every view-enter shows variety without re-querying.
const PREVIEW_POOL_SIZE = 40

/**
 * All data the Search landing page renders, loaded as one batch behind a single
 * `ready` flag: collection groups, the flat collection list, the random lecture
 * pool, the scoped lecture count, plus the shared dictionaries and on-device
 * recommendations.
 *
 * The page used to load each section from its own composable/store, so the
 * sections popped in one by one and the layout jumped. Here `ensureLoaded()`
 * fans them all out in parallel and only flips `ready` when every piece has
 * resolved, so the page renders fully formed in one step. It is warmed at app
 * startup (see main.ts), so by the time the user opens the tab the data is
 * already in memory; the view shows AppPage's centered spinner only for the
 * rare cold open that beats the preload.
 */
export const useLibraryLandingStore = defineStore("libraryLanding", () => {
  const app = useLectorium()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  const dictionaries = useDictionariesStore()
  const recommendations = useRecommendationsStore()

  const collectionGroups = ref<readonly CollectionGroupView[]>([])
  const allCollections = ref<readonly GroupCollection[]>([])
  const lecturePool = ref<readonly Track[]>([])
  const lectureCount = ref(0)
  /** Flips true after the first full parallel load; gates the page render. */
  const ready = ref(false)

  // Track the (UI-language, library-languages) pair the loaded data belongs to
  // so a language switch reloads, and coalesce concurrent loads (startup
  // preload + the view's own mount call) onto one run.
  let loadedKey: string | null = null
  let inFlight: { key: string; promise: Promise<void> } | null = null

  function currentKey(): string {
    return `${appLanguage.value}|${[...libraryLanguages.value].join(",")}`
  }

  async function loadCollections(locale: string): Promise<void> {
    try {
      const repos = app.repositories()
      const [headers, flat] = await Promise.all([
        repos.collections.listGroups(locale),
        repos.collections.listCollections(locale),
      ])
      const built = await Promise.all(
        headers.map(async (g) => {
          const cols = await repos.collections.getGroupCollections(g.id, locale)
          return {
            id: g.id,
            name: g.name,
            collections: cols.map((c) => ({
              id: c.id,
              name: c.name,
              coverUrl: resolveAssetUrl(c.cover),
            })),
          }
        })
      )
      // Drop empty groups so the page shows no empty shelves.
      collectionGroups.value = built.filter((g) => g.collections.length > 0)
      allCollections.value = flat.map((c) => ({
        id: c.id,
        name: c.name,
        coverUrl: resolveAssetUrl(c.cover),
        description: c.description,
      }))
    } catch (err) {
      console.warn("[library-landing] collections load failed", err)
      collectionGroups.value = []
      allCollections.value = []
    }
  }

  async function loadLecturePool(language: string): Promise<void> {
    try {
      lecturePool.value = await searchAndFilterTracks(
        { query: "", languageCodes: [language], limit: PREVIEW_POOL_SIZE, offset: 0 },
        { tracks: app.repositories().tracks }
      )
    } catch (err) {
      console.warn("[library-landing] lecture pool load failed", err)
      lecturePool.value = []
    }
  }

  async function loadLectureCount(languages: readonly LanguageCode[]): Promise<void> {
    try {
      lectureCount.value = await app
        .repositories()
        .tracks.count(languages.length ? { languageCodes: languages } : undefined)
    } catch (err) {
      console.warn("[library-landing] lecture count failed", err)
    }
  }

  async function load(key: string): Promise<void> {
    const language = appLanguage.value
    await Promise.all([
      loadCollections(language),
      loadLecturePool(language),
      loadLectureCount(libraryLanguages.value),
      dictionaries.ensureLoaded(),
      recommendations.refresh(),
    ])
    loadedKey = key
    ready.value = true
  }

  /**
   * Load every section in parallel, once per (UI-language, library-languages)
   * pair. Concurrent calls for the same pair share one run. A language switch
   * reloads but keeps the already-shown content visible until the new set is
   * ready, so no spinner flashes mid-session.
   */
  function ensureLoaded(): Promise<void> {
    const key = currentKey()
    if (key === loadedKey) return Promise.resolve()
    if (inFlight && inFlight.key === key) return inFlight.promise
    const promise = load(key).finally(() => {
      if (inFlight?.promise === promise) inFlight = null
    })
    inFlight = { key, promise }
    return promise
  }

  return {
    collectionGroups,
    allCollections,
    lecturePool,
    lectureCount,
    ready,
    ensureLoaded,
  }
})
