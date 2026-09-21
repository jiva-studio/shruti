import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import type { LanguageCode, TopicId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { preferredLibraryLanguage } from "@lib/domain/services/localizedName.js"
import { useShruti } from "@shruti/shruti.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { filterByLanguages, hydrateTracks } from "./collectionTracks.js"

const TOPIC_TRACKS = 50

export type CollectionKind = "collection" | "topic"

/** `missing` is an entity the catalog does not hold in this content language —
 *  a language switch with the page open lands here; `failed` is a throw. */
export type CollectionLoadError = "missing" | "failed"

export interface UseCollectionDetailReturn {
  title: Ref<string>
  description: Ref<string | null>
  coverKey: Ref<string | null>
  trackIds: Ref<readonly string[]>
  tracks: Ref<readonly Track[]>
  loading: Ref<boolean>
  error: Ref<CollectionLoadError | null>
  contentLanguage: ComputedRef<string>
}

interface Header {
  readonly title: string
  readonly description: string | null
  readonly coverKey: string | null
  readonly trackIds: readonly string[]
}

/**
 * Loads one track-bearing entity — a collection or a recommender topic —
 * and keeps it in step with the library content language.
 */
export function useCollectionDetail(
  id: Ref<string>,
  kind: Ref<CollectionKind>
): UseCollectionDetailReturn {
  const app = useShruti()
  const dictionaries = useDictionariesStore()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()

  const title = ref("")
  const description = ref<string | null>(null)
  const coverKey = ref<string | null>(null)
  const trackIds = ref<readonly string[]>([])
  const tracks = ref<readonly Track[]>([])
  const loading = ref(false)
  const error = ref<CollectionLoadError | null>(null)

  // A collection is curated per language, so it loads in the library content
  // language with the UI locale only as a tie-breaker: loading it in the UI
  // language returns off-language ids the filter below then drops.
  const contentLanguage = computed(() =>
    preferredLibraryLanguage(libraryLanguages.value, appLanguage.value)
  )

  // An in-place language switch re-runs load() without re-mounting, so an
  // older multi-await load must not overwrite what a newer one has put up.
  let loadGen = 0

  /** Name and cover only — both are in the dictionary, so the hero can go up
   *  before the membership query runs rather than after it. */
  async function loadTopicChrome(topicId: string): Promise<Omit<Header, "trackIds">> {
    await dictionaries.ensureLoaded()
    return {
      title: dictionaries.topicNamesById.get(topicId) ?? topicId,
      description: null,
      coverKey: dictionaries.topicCoverById.get(topicId) ?? null,
    }
  }

  /** Topic membership, filtered to the library languages in SQL. */
  async function loadTopicTrackIds(topicId: string): Promise<readonly string[]> {
    return app
      .repositories()
      .topics.topTrackIds(
        topicId as TopicId,
        libraryLanguages.value as LanguageCode[],
        TOPIC_TRACKS
      )
  }

  async function loadCollectionHeader(
    collectionId: string,
    locale: string
  ): Promise<Header | null> {
    const d = await app.repositories().collections.getCollection(collectionId, locale)
    if (!d) return null
    return {
      title: d.name,
      description: d.description || null,
      coverKey: d.cover || null,
      trackIds: d.trackIds,
    }
  }

  function applyChrome(chrome: Omit<Header, "trackIds">): void {
    title.value = chrome.title
    description.value = chrome.description
    coverKey.value = chrome.coverKey
  }

  /** Chrome up first, then the membership query — a topic's name and cover do
   *  not depend on it, and waiting left a blank hero on screen. */
  async function topicTrackIds(
    topicId: string,
    isCurrent: () => boolean
  ): Promise<readonly string[] | null> {
    const chrome = await loadTopicChrome(topicId)
    if (!isCurrent()) return []
    applyChrome(chrome)
    return loadTopicTrackIds(topicId)
  }

  /** `null` when there is no such collection. */
  async function collectionTrackIds(
    collectionId: string,
    locale: string,
    isCurrent: () => boolean
  ): Promise<readonly string[] | null> {
    const header = await loadCollectionHeader(collectionId, locale)
    if (!isCurrent()) return []
    if (!header) return null
    applyChrome(header)
    return header.trackIds
  }

  function clear(): void {
    title.value = ""
    description.value = null
    coverKey.value = null
    trackIds.value = []
    tracks.value = []
    error.value = null
  }

  async function load(nextKind: CollectionKind, nextId: string, locale: string): Promise<void> {
    const myGen = ++loadGen
    loading.value = true
    clear()
    try {
      const isTopic = nextKind === "topic"
      const isCurrent = (): boolean => myGen === loadGen
      const ids = isTopic
        ? await topicTrackIds(nextId, isCurrent)
        : await collectionTrackIds(nextId, locale, isCurrent)
      if (!isCurrent()) return
      if (ids === null) {
        error.value = "missing"
        return
      }
      const header = { trackIds: ids }
      if (header.trackIds.length === 0) return
      const byId = await app.repositories().tracks.getByIds([...header.trackIds])
      if (myGen !== loadGen) return
      const hydrated = hydrateTracks(header.trackIds, byId)
      const visible = isTopic ? hydrated : filterByLanguages(hydrated, libraryLanguages.value)
      tracks.value = visible
      trackIds.value = visible.map((tr) => tr.id)
    } catch (err) {
      console.warn("[detail] load failed", err)
      if (myGen === loadGen) error.value = "failed"
    } finally {
      if (myGen === loadGen) loading.value = false
    }
  }

  watch(
    () => [id.value, kind.value, contentLanguage.value] as const,
    ([nextId, nextKind, locale]) => void load(nextKind, nextId, locale),
    { immediate: true }
  )

  return { title, description, coverKey, trackIds, tracks, loading, error, contentLanguage }
}
