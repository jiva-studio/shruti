import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
import { prewarmImageCache } from "@shruti/services/prewarmImageCache.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useRecommendationsStore } from "@shruti/stores/useRecommendationsStore.js"
import { useSearchFiltersStore } from "@shruti/stores/useSearchFiltersStore.js"
import { pickLandingSections } from "@shruti/stores/library/landingPicks.js"
import { useLandingSources } from "@shruti/wiring/landingSources.js"
import type { CollectionGroupView, GroupCollection } from "@usecases/catalog/loadLandingSections.js"
import { preferredLibraryLanguage } from "@lib/domain/services/localizedName.js"
import type { CarouselItem } from "@ui/features/collections/index.js"
import type { Track } from "@lib/domain/track.js"
import type { TopicId } from "@lib/domain/core.js"
import type { DiscoveryHit } from "@lib/contracts"
import { fetchDiscoveredHits } from "./library/landingDiscovered.js"

/** How many collection groups the page shows as shelves. */
const TOP_GROUPS = 2

/**
 * All data the Search landing page renders, loaded as one batch behind a single
 * `ready` flag: collection groups, the flat collection list, the random lecture
 * pool, the scoped lecture count, plus the shared dictionaries and on-device
 * recommendations.
 */
export const useLibraryLandingStore = defineStore("libraryLanding", () => {
  const app = useShruti()
  const openSources = useLandingSources()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  const filters = useSearchFiltersStore()
  const dictionaries = useDictionariesStore()
  const recommendations = useRecommendationsStore()

  const collectionGroups = ref<readonly CollectionGroupView[]>([])
  const allCollections = ref<readonly GroupCollection[]>([])
  const lecturePool = ref<readonly Track[]>([])
  const lectureCount = ref(0)
  const ready = ref(false)

  const topGroups = computed<readonly CollectionGroupView[]>(() =>
    collectionGroups.value.slice(0, TOP_GROUPS)
  )
  const otherCollections = ref<readonly GroupCollection[]>([])
  const topicTiles = ref<readonly CarouselItem[]>([])
  const lectureSample = ref<readonly Track[]>([])
  const latestDiscovered = ref<readonly DiscoveryHit[]>([])
  const isDiscoveredLoading = ref(false)
  const allowedTopicIds = ref<ReadonlySet<TopicId> | null>(null)

  let loadedKey: string | null = null
  let inFlight: { key: string; promise: Promise<void> } | null = null
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

  function shownCoverUrls(): (string | undefined)[] {
    return [
      ...topGroups.value.flatMap((g) => g.collections.map((c) => c.coverUrl)),
      ...otherCollections.value.map((c) => c.coverUrl),
      ...topicTiles.value.map((t) => t.coverUrl),
      ...latestDiscovered.value.map((d) => d.cover_url),
    ]
  }

  function hasAnyLandingData(
    collections: { groups: readonly unknown[]; flat: readonly unknown[] },
    pool: readonly unknown[],
    hits?: readonly unknown[]
  ): boolean {
    return (
      collections.groups.length > 0 ||
      collections.flat.length > 0 ||
      pool.length > 0 ||
      Boolean(hits && hits.length > 0)
    )
  }

  async function load(key: string): Promise<void> {
    const generation = ++loadGeneration
    const sources = openSources()
    if (sources === null) return
    const languages = [...libraryLanguages.value]
    const language = preferredLibraryLanguage(languages, appLanguage.value)
    isDiscoveredLoading.value = true
    const [collections, pool, count, allowedTopics, , , hits] = await Promise.all([
      sources.collections(language),
      sources.lecturePool(languages),
      sources.lectureCount(languages),
      sources.allowedTopicIds(languages),
      dictionaries.ensureLoaded(),
      recommendations.refresh(),
      fetchDiscoveredHits(app.discoveryClient, languages),
    ])
    isDiscoveredLoading.value = false
    if (generation !== loadGeneration) return
    if (!hasAnyLandingData(collections, pool, hits)) return

    collectionGroups.value = collections.groups
    allCollections.value = collections.flat
    lecturePool.value = pool
    if (count !== null) lectureCount.value = count
    allowedTopicIds.value = allowedTopics
    latestDiscovered.value = hits

    applyPicks()
    loadedKey = key
    ready.value = true
    void prewarmImageCache(app.filesStorage, shownCoverUrls())
  }

  async function ensureLoaded(): Promise<void> {
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
    latestDiscovered,
    isDiscoveredLoading,
    ready,
    ensureLoaded,
  }
})
