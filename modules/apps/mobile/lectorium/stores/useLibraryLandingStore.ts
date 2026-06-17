import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"
import { prewarmImageCache } from "@lectorium/services/prewarmImageCache.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useRecommendationsStore } from "@lectorium/stores/useRecommendationsStore.js"
import { shuffled } from "@lectorium/utils/shuffle.js"
import { searchAndFilterTracks } from "@usecases/discovery/searchAndFilterTracks.js"
import type { CarouselItem } from "@ui/features/collections/index.js"
import type { Track } from "@lib/domain/track.js"
import type { LanguageCode, TopicId } from "@lib/domain/core.js"

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
// the picked sample shows variety without re-querying.
const PREVIEW_POOL_SIZE = 40
// How much of each section the landing actually shows. The picks are derived
// once per load (below) so the page — and the image prewarm — know the exact
// shown set up front, before the view mounts.
const TOP_GROUPS = 2
const OTHER_COLLECTIONS = 4
const TOPIC_TILES = 6
const PREVIEW_LECTURES = 10

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

  // The exact subsets the landing renders, derived once per load. The view just
  // reads them (no picking logic in the component), and the load fills them
  // before flipping `ready` — so they are settled before the view mounts.
  const topGroups = computed<readonly CollectionGroupView[]>(() =>
    collectionGroups.value.slice(0, TOP_GROUPS)
  )
  const otherCollections = ref<readonly GroupCollection[]>([])
  const topicTiles = ref<readonly CarouselItem[]>([])
  const lectureSample = ref<readonly Track[]>([])

  // The topic ids that have ≥1 lecture in the selected library languages, used
  // to drop topic tiles whose topic page would be empty under the current
  // language. `null` means "no language filter" (no library languages selected
  // ⇒ show every topic), distinct from an empty set (languages selected but no
  // topic matched ⇒ show none).
  const allowedTopicIds = ref<ReadonlySet<TopicId> | null>(null)

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

  async function loadLecturePool(languages: readonly LanguageCode[]): Promise<void> {
    try {
      lecturePool.value = await searchAndFilterTracks(
        {
          query: "",
          languageCodes: languages.length ? languages : undefined,
          limit: PREVIEW_POOL_SIZE,
          offset: 0,
        },
        { tracks: app.repositories().tracks }
      )
    } catch (err) {
      console.warn("[library-landing] lecture pool load failed", err)
      lecturePool.value = []
    }
  }

  async function loadAllowedTopicIds(languages: readonly LanguageCode[]): Promise<void> {
    // No library languages selected ⇒ no filter (show every topic tile). With
    // languages selected, only topics that have a lecture in one of them pass.
    if (languages.length === 0) {
      allowedTopicIds.value = null
      return
    }
    try {
      const ids = await app.repositories().topics.topicIdsWithTracksIn(languages)
      allowedTopicIds.value = new Set(ids)
    } catch (err) {
      console.warn("[library-landing] allowed topic ids load failed", err)
      // On failure fall back to "no filter" so we never blank the tile grid.
      allowedTopicIds.value = null
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

  // Derive the shown subsets from the loaded data. The "other collections" and
  // topic tiles are a random sample (variety between loads); the topic-tile grid
  // skips the topics already shown as listening shelves so nothing repeats.
  function pickShownSets(): void {
    const shownIds = new Set(topGroups.value.flatMap((g) => g.collections.map((c) => c.id)))
    otherCollections.value = shuffled(
      allCollections.value.filter((c) => !shownIds.has(c.id))
    ).slice(0, OTHER_COLLECTIONS)

    const inShelves = new Set(recommendations.shelves.map((s) => s.topicId))
    // Drop topics with no lecture in the selected library languages so a tile
    // never opens onto an empty topic page. `null` = no language filter.
    const allowed = allowedTopicIds.value
    topicTiles.value = shuffled(
      dictionaries.topics.filter(
        (t) => !inShelves.has(t.id) && (allowed === null || allowed.has(t.id))
      )
    )
      .slice(0, TOPIC_TILES)
      .map((topic) => ({
        id: topic.id,
        name: dictionaries.topicShortNamesById.get(topic.id) ?? topic.id,
        coverUrl: topic.cover ? resolveAssetUrl(topic.cover) : undefined,
      }))

    lectureSample.value = shuffled(lecturePool.value).slice(0, PREVIEW_LECTURES)
  }

  /** Every cover the landing will render — and nothing else. */
  function shownCoverUrls(): (string | undefined)[] {
    return [
      ...topGroups.value.flatMap((g) => g.collections.map((c) => c.coverUrl)),
      ...otherCollections.value.map((c) => c.coverUrl),
      ...topicTiles.value.map((t) => t.coverUrl),
    ]
  }

  async function load(key: string): Promise<void> {
    const language = appLanguage.value
    await Promise.all([
      loadCollections(language),
      loadLecturePool(libraryLanguages.value),
      loadLectureCount(libraryLanguages.value),
      loadAllowedTopicIds(libraryLanguages.value),
      dictionaries.ensureLoaded(),
      recommendations.refresh(),
    ])
    // The catalog DB may still be downloading/opening on a fresh or cleared
    // start (the startup preload from main.ts fires before the Welcome bootstrap
    // finishes), in which case every query above came back empty. Don't commit
    // that as the loaded state — leave the key unset and `ready` false so the
    // next ensureLoaded() (the Search view entering once the DB is ready) reruns
    // the load against real data instead of sticking on the empty result.
    const hasData =
      collectionGroups.value.length > 0 ||
      allCollections.value.length > 0 ||
      lecturePool.value.length > 0
    if (!hasData) return

    pickShownSets()
    loadedKey = key
    ready.value = true
    // Warm the on-device image cache for exactly the covers this page will
    // render, here in the prefetch layer (run from main.ts at startup) so they
    // are cached before the view ever mounts — no placeholder → fade-in on open.
    // Fire-and-forget: gentle background work that never gates `ready`.
    void prewarmImageCache(app.filesStorage, shownCoverUrls())
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
    topGroups,
    otherCollections,
    topicTiles,
    lectureSample,
    ready,
    ensureLoaded,
  }
})
