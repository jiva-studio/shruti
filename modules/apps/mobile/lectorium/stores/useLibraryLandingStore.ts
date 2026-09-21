import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { prewarmImageCache } from "@lectorium/services/prewarmImageCache.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useRecommendationsStore } from "@lectorium/stores/useRecommendationsStore.js"
import { useSearchFiltersStore } from "@lectorium/stores/useSearchFiltersStore.js"
import { pickLandingSections } from "@lectorium/stores/library/landingPicks.js"
import {
  loadAllowedTopicIds,
  loadCollections,
  loadLectureCount,
  loadLecturePool,
  type CollectionGroupView,
  type GroupCollection,
} from "@lectorium/stores/library/landingSources.js"
import { preferredLibraryLanguage } from "@lib/domain/services/localizedName.js"
import type { CarouselItem } from "@ui/features/collections/index.js"
import type { Track } from "@lib/domain/track.js"
import type { TopicId } from "@lib/domain/core.js"

export type { CollectionGroupView, GroupCollection }

/** How many collection groups the page shows as shelves. */
const TOP_GROUPS = 2

/**
 * All data the Search landing page renders, loaded as one batch behind a single
 * `ready` flag: collection groups, the flat collection list, the random lecture
 * pool, the scoped lecture count, plus the shared dictionaries and on-device
 * recommendations.
 *
 * `ensureLoaded()` fans every section out in parallel and only flips `ready`
 * when all of them have resolved, so the page renders fully formed in one step
 * instead of popping in section by section. It is warmed at app startup (see
 * main.ts), so the view shows a spinner only on a cold open that beats the
 * preload.
 */
export const useLibraryLandingStore = defineStore("libraryLanding", () => {
  const app = useLectorium()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  const filters = useSearchFiltersStore()
  const dictionaries = useDictionariesStore()
  const recommendations = useRecommendationsStore()

  const collectionGroups = ref<readonly CollectionGroupView[]>([])
  const allCollections = ref<readonly GroupCollection[]>([])
  const lecturePool = ref<readonly Track[]>([])
  const lectureCount = ref(0)
  /** Flips true after the first full parallel load; gates the page render. */
  const ready = ref(false)

  // The exact subsets the landing renders, derived once per load — the view
  // just reads them, and the load fills them before flipping `ready`.
  const topGroups = computed<readonly CollectionGroupView[]>(() =>
    collectionGroups.value.slice(0, TOP_GROUPS)
  )
  const otherCollections = ref<readonly GroupCollection[]>([])
  const topicTiles = ref<readonly CarouselItem[]>([])
  const lectureSample = ref<readonly Track[]>([])

  const allowedTopicIds = ref<ReadonlySet<TopicId> | null>(null)

  // The (UI-language, library-languages) pair the loaded data belongs to, so a
  // language switch reloads; concurrent loads for the same pair share one run.
  let loadedKey: string | null = null
  let inFlight: { key: string; promise: Promise<void> } | null = null
  // Generation token. `ensureLoaded` coalesces only calls for the SAME key, so
  // switching library language mid-load leaves two loads in flight writing the
  // same refs. Each captures the token at entry; a load that is no longer the
  // newest commits nothing.
  let loadGeneration = 0

  function currentKey(): string {
    return `${appLanguage.value}|${[...libraryLanguages.value].join(",")}`
  }

  function applyPicks(): void {
    const picks = pickLandingSections({
      topGroups: topGroups.value,
      allCollections: allCollections.value,
      topics: dictionaries.topics,
      topicShortNamesById: dictionaries.topicShortNamesById,
      shelfTopicIds: new Set(recommendations.shelves.map((s) => s.topicId)),
      allowedTopicIds: allowedTopicIds.value,
      lecturePool: lecturePool.value,
    })
    otherCollections.value = picks.otherCollections
    topicTiles.value = picks.topicTiles
    lectureSample.value = picks.lectureSample
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
    const generation = ++loadGeneration
    // On a fresh or cleared start this throws until both databases are open,
    // and every caller fires this as `void ensureLoaded()`. Leave `ready` and
    // `loadedKey` unset so the next call retries against real data — the same
    // empty-degrade the section loaders below perform.
    let repos: ReturnType<typeof app.repositories>
    try {
      repos = app.repositories()
    } catch {
      return
    }
    // The languages this run is for, captured up front: they are reactive, and
    // reading them after the awaits would mix a later switch into this commit.
    const languages = [...libraryLanguages.value]
    // Collections are curated per language; scope them to the chosen library
    // content language, not the UI locale, so the cards match the lectures the
    // page shows.
    const language = preferredLibraryLanguage(languages, appLanguage.value)
    const [collections, pool, count, allowedTopics] = await Promise.all([
      loadCollections(repos, language),
      loadLecturePool(repos, languages),
      loadLectureCount(repos, languages),
      loadAllowedTopicIds(repos, languages),
      dictionaries.ensureLoaded(),
      recommendations.refresh(),
    ])
    // A newer load (a language switch while this one was in flight) has taken
    // over. Commit nothing: the refs belong to the language the user is on.
    if (generation !== loadGeneration) return

    // The catalog DB may still be downloading/opening on a fresh or cleared
    // start, in which case every query above came back empty. Leave the key
    // unset and `ready` false so the next ensureLoaded() reruns against real
    // data rather than sticking on the empty result.
    const hasData = collections.groups.length > 0 || collections.flat.length > 0 || pool.length > 0
    if (!hasData) return

    collectionGroups.value = collections.groups
    allCollections.value = collections.flat
    lecturePool.value = pool
    if (count !== null) lectureCount.value = count
    allowedTopicIds.value = allowedTopics

    applyPicks()
    loadedKey = key
    ready.value = true
    // Warm the image cache for exactly the covers this page will render, before
    // the view ever mounts. Fire-and-forget: it never gates `ready`.
    void prewarmImageCache(app.filesStorage, shownCoverUrls())
  }

  /**
   * Load every section in parallel, once per (UI-language, library-languages)
   * pair. Concurrent calls for the same pair share one run. A language switch
   * reloads but keeps the already-shown content visible until the new set is
   * ready, so no spinner flashes mid-session.
   */
  async function ensureLoaded(): Promise<void> {
    // Settle the library-language seed BEFORE computing the key or querying:
    // `useLibraryLanguages()` only fires the filter store's lazy load, so on a
    // cold open the landing would query an all-languages pool and an inflated
    // count, then reload a tick later when the seed lands.
    await filters.load()

    const key = currentKey()
    if (key === loadedKey) return
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
