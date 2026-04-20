import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useIonRouter } from "@ionic/vue"
import { useDebounceFn } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { listTracksByFilters } from "@lib/application/listTracksByFilters.js"
import { searchTracks } from "@lib/application/searchTracks.js"
import type { Author } from "@lib/domain/author.js"
import type { Language } from "@lib/domain/language.js"
import type { Location } from "@lib/domain/location.js"
import type { Track } from "@lib/domain/track.js"
import { DURATION_FILTERS, type DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import type { Source } from "@lib/domain/source.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { buildTrackRow } from "@lectorium/composables/buildTrackRow.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useDownloadStore, type DownloadState } from "@lectorium/stores/useDownloadStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useSearchFiltersStore } from "@lectorium/stores/useSearchFiltersStore.js"
import { useToast } from "@lectorium/services/useToast.js"
import type { UiTrackRow, UiTrackState } from "@ui/features/tracks.list/index.js"
import type { SelectorDialogItem } from "@ui/features/selectors/index.js"
import type { FiltersModel } from "@ui/features/tracks.search.filters/index.js"

export interface SearchControllerReturn {
  query: Ref<string>
  rows: ComputedRef<readonly UiTrackRow[]>
  isLoading: Ref<boolean>
  error: Ref<string | null>
  emptyMessage: ComputedRef<string>
  filters: Ref<FiltersModel>
  authorsItems: ComputedRef<SelectorDialogItem[]>
  languagesItems: ComputedRef<SelectorDialogItem[]>
  locationsItems: ComputedRef<SelectorDialogItem[]>
  durationItems: ComputedRef<SelectorDialogItem[]>
  sortItems: ComputedRef<SelectorDialogItem[]>
  authorsTitle: ComputedRef<string>
  languagesTitle: ComputedRef<string>
  locationsTitle: ComputedRef<string>
  durationTitle: ComputedRef<string>
  sortTitle: ComputedRef<string>
  datesTitle: ComputedRef<string>
  onSelect: (trackId: string) => Promise<void>
}

export function useSearchController(): SearchControllerReturn {
  const appLanguage = useAppLanguage()

  const app = useLectorium()
  const router = useIonRouter()
  const repos = app.repositories()
  const filtersStore = useSearchFiltersStore()
  const { t } = useI18n()

  const query = ref<string>("")
  const rawTracks = ref<readonly Track[]>([])
  const authorsById = ref<ReadonlyMap<string, Author>>(new Map())
  const authorsSorted = ref<readonly Author[]>([])
  const locationsById = ref<ReadonlyMap<string, Location>>(new Map())
  const locationsSorted = ref<readonly Location[]>([])
  const sourcesById = ref<ReadonlyMap<string, Source>>(new Map())
  const languages = ref<readonly Language[]>([])
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)

  const filters = ref<FiltersModel>({})

  onMounted(async () => {
    await filtersStore.load()
    filters.value = {
      authors: [...filtersStore.authorIds],
      languages: [...filtersStore.languageCodes],
      locations: [...filtersStore.locationIds],
      duration: filtersStore.duration[0],
      sort: filtersStore.sort,
    }
    try {
      const [authorList, languageList, locationList, sourceList] = await Promise.all([
        repos.authors.listAll(),
        repos.languages.listAll(),
        repos.locations.listAll(),
        repos.sources.listAll(),
      ])
      sourcesById.value = new Map(sourceList.map((s) => [s.id, s]))
      authorsById.value = new Map(authorList.map((a) => [a.id, a]))
      authorsSorted.value = [...authorList].sort((a, b) =>
        (a.names.get(appLanguage.value) ?? a.id).localeCompare(
          b.names.get(appLanguage.value) ?? b.id
        )
      )
      locationsById.value = new Map(locationList.map((l) => [l.id, l]))
      locationsSorted.value = [...locationList].sort((a, b) =>
        (a.names.get(appLanguage.value) ?? a.id).localeCompare(
          b.names.get(appLanguage.value) ?? b.id
        )
      )
      languages.value = languageList
    } catch (err) {
      console.error("failed to load search dictionaries", err)
    }
    await runQuery()
  })

  let searchToken = 0

  async function runQuery(): Promise<void> {
    const token = ++searchToken
    error.value = null
    const text = query.value.trim()
    const hasFilter = activeFilters()

    if (!text && !hasFilter) {
      rawTracks.value = []
      isLoading.value = false
      return
    }

    isLoading.value = true
    try {
      let tracks: readonly Track[]
      if (text) {
        // FTS matches across all languages — cross-locale by design.
        const all = await searchTracks(
          { query: text, limit: 200 },
          { tracks: repos.tracks }
        )
        tracks = narrowTracks(all)
      } else {
        tracks = await listTracksByFilters(
          {
            authorIds: filters.value.authors,
            languageCodes: filters.value.languages,
            locationIds: filters.value.locations,
            durationFilter: filters.value.duration as DurationFilterId | undefined,
            sortBy: filters.value.sort as SortMethod | undefined,
            limit: 200,
          },
          { tracks: repos.tracks }
        )
      }
      if (token !== searchToken) return
      rawTracks.value = tracks
    } catch (err) {
      if (token !== searchToken) return
      error.value = err instanceof Error ? err.message : "Search failed"
      rawTracks.value = []
    } finally {
      if (token === searchToken) isLoading.value = false
    }
  }

  function activeFilters(): boolean {
    const f = filters.value
    return (
      (f.authors?.length ?? 0) > 0 ||
      (f.languages?.length ?? 0) > 0 ||
      (f.locations?.length ?? 0) > 0 ||
      (f.duration !== undefined && f.duration !== "") ||
      (f.sort !== undefined && f.sort !== "")
    )
  }

  function narrowTracks(tracks: readonly Track[]): readonly Track[] {
    const authorSet = new Set(filters.value.authors ?? [])
    const languageSet = new Set(filters.value.languages ?? [])
    const locationSet = new Set(filters.value.locations ?? [])
    const durationBucket = filters.value.duration
      ? DURATION_FILTERS.find((d) => d.id === filters.value.duration)
      : null

    return tracks.filter((t) => {
      if (authorSet.size > 0 && (!t.authorId || !authorSet.has(t.authorId))) return false
      if (locationSet.size > 0 && (!t.locationId || !locationSet.has(t.locationId))) return false
      if (languageSet.size > 0 && !t.variants.some((v) => languageSet.has(v.language))) return false
      if (durationBucket) {
        const anyInRange = t.variants.some((v) => {
          const d = v.audio?.duration
          return (
            d !== null && d !== undefined && d >= durationBucket.minMs && d < durationBucket.maxMs
          )
        })
        if (!anyInRange) return false
      }
      return true
    })
  }

  // Text input is debounced so fast typing / backspace doesn't spam
  // SQL on every keystroke. Filter chips run immediately — they fire
  // once per user gesture, no flood to worry about.
  const debouncedRun = useDebounceFn(() => runQuery(), 200)
  watch(query, () => {
    void debouncedRun()
  })

  watch(
    filters,
    (next) => {
      void filtersStore.setAuthors(next.authors ?? [])
      void filtersStore.setLanguages(next.languages ?? [])
      void filtersStore.setLocations(next.locations ?? [])
      void filtersStore.setDuration(next.duration ? [next.duration as DurationFilterId] : [])
      void filtersStore.setSort(next.sort as "byReference" | "byDate" | undefined)
      void runQuery()
    },
    { deep: true }
  )

  const downloads = useDownloadStore()

  function toUiState(trackId: string, downloadState: DownloadState): UiTrackState {
    if (downloadState === "downloading") return "downloading"
    if (downloadState === "completed") return "completed"
    if (downloadState === "failed") return "failed"
    // Surface "added" when the track is already in the user's playlist
    // but no download has been triggered yet in this session.
    return playlist.hasTrack(trackId) ? "added" : "none"
  }

  // Rows recompute reactively when the UI language changes so the
  // user sees localised author/location/source names the moment they
  // flip the toggle in Settings — no re-query needed.
  const rows = computed<readonly UiTrackRow[]>(() => {
    void downloads.states
    void playlist.entries
    return rawTracks.value.map((track) =>
      buildTrackRow(track, {
        preferredLanguage: appLanguage.value,
        authorsById: authorsById.value,
        locationsById: locationsById.value,
        sourcesById: sourcesById.value,
        state: toUiState(track.id, downloads.getState(track.id)),
      })
    )
  })

  const emptyMessage = computed(() => {
    if (isLoading.value) return ""
    if (!query.value.trim() && !activeFilters()) {
      return t("search.specifySearchCriteria")
    }
    return ""
  })

  const authorsItems = computed<SelectorDialogItem[]>(() =>
    authorsSorted.value.map((a) => ({
      id: a.id,
      title: a.names.get(appLanguage.value) ?? a.id,
    }))
  )

  const languagesItems = computed<SelectorDialogItem[]>(() =>
    languages.value.map((l) => ({ id: l.code, title: l.fullName }))
  )

  const locationsItems = computed<SelectorDialogItem[]>(() =>
    locationsSorted.value.map((l) => ({
      id: l.id,
      title: l.names.get(appLanguage.value) ?? l.id,
    }))
  )

  const durationItems = computed<SelectorDialogItem[]>(() => [
    { id: "short", title: t("search.filters.durationShort") },
    { id: "medium", title: t("search.filters.durationMedium") },
    { id: "long", title: t("search.filters.durationLong") },
  ])

  const sortItems = computed<SelectorDialogItem[]>(() => [
    { id: "byDate", title: t("search.filters.dates") },
    { id: "byReference", title: t("search.filters.sort") },
  ])

  const authorsTitle = computed(() => t("search.filters.authors"))
  const languagesTitle = computed(() => t("search.filters.languages"))
  const locationsTitle = computed(() => t("search.filters.locations"))
  const durationTitle = computed(() => t("search.filters.duration"))
  const sortTitle = computed(() => t("search.filters.sort"))
  const datesTitle = computed(() => t("search.filters.dates"))

  const toast = useToast()
  const playlist = usePlaylistStore()

  // Tap on a search result → add the track to the playlist (idempotent)
  // via the shared store so Home reflects the change immediately. The
  // legacy app emitted a separate `trackDownload` event here; download
  // infra lands alongside IMediaDownloader wiring.
  async function onSelect(trackId: string): Promise<void> {
    const result = await playlist.add(trackId)
    if (result.ok) {
      await toast.info(t("search.notifications.newTrackAddedToPlaylist"))
    } else if (result.error === "already-in-playlist") {
      await toast.info(t("search.alreadyInPlaylist"))
    }
  }

  return {
    query,
    rows,
    isLoading,
    error,
    emptyMessage,
    filters,
    authorsItems,
    languagesItems,
    locationsItems,
    durationItems,
    sortItems,
    authorsTitle,
    languagesTitle,
    locationsTitle,
    durationTitle,
    sortTitle,
    datesTitle,
    onSelect,
  }
}
