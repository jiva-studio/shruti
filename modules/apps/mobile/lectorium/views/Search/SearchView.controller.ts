import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useDebounceFn } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { searchAndFilterTracks } from "@lib/application/searchAndFilterTracks.js"
import type { Track } from "@lib/domain/track.js"
import { type DurationFilterId } from "@lib/domain/durationFilters.js"
import type { SortMethod } from "@lib/domain/sortMethods.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { buildTrackRow } from "@lectorium/composables/buildTrackRow.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useDownloadStore, type DownloadState } from "@lectorium/stores/useDownloadStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useSearchFiltersStore } from "@lectorium/stores/useSearchFiltersStore.js"
import { useToast } from "@lectorium/services/useToast.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"
import type { SelectorDialogItem } from "@ui/components/selectors/index.js"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"

export interface SearchControllerReturn {
  query: Ref<string>
  rows: ComputedRef<readonly UiTrackRow[]>
  isLoading: Ref<boolean>
  error: Ref<string | null>
  emptyMessage: ComputedRef<string>
  filters: Ref<FiltersModel>
  hasMore: Ref<boolean>
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
  loadMore: () => Promise<void>
}

const PAGE_SIZE = 50

export function useSearchController(): SearchControllerReturn {
  const appLanguage = useAppLanguage()

  const app = useLectorium()
  const repos = app.repositories()
  const filtersStore = useSearchFiltersStore()
  const dictionaries = useDictionariesStore()
  const { t } = useI18n()

  const query = ref<string>("")
  const rawTracks = ref<readonly Track[]>([])
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  const offset = ref<number>(0)
  const hasMore = ref<boolean>(false)

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
    await dictionaries.ensureLoaded()
    await runQuery()
  })

  let searchToken = 0

  async function fetchPage(pageOffset: number): Promise<readonly Track[]> {
    return searchAndFilterTracks(
      {
        query: query.value,
        authorIds: filters.value.authors,
        languageCodes: filters.value.languages,
        locationIds: filters.value.locations,
        durationFilter: filters.value.duration as DurationFilterId | undefined,
        sortBy: filters.value.sort as SortMethod | undefined,
        limit: PAGE_SIZE,
        offset: pageOffset,
      },
      { tracks: repos.tracks }
    )
  }

  async function runQuery(): Promise<void> {
    const token = ++searchToken
    error.value = null
    const text = query.value.trim()
    const hasFilter = activeFilters()

    offset.value = 0
    hasMore.value = false

    if (!text && !hasFilter) {
      rawTracks.value = []
      isLoading.value = false
      return
    }

    isLoading.value = true
    try {
      const tracks = await fetchPage(0)
      if (token !== searchToken) return
      rawTracks.value = tracks
      // When FTS + client-side filter trims the page heavily, we can
      // get a short "page" while the DB still has more rows. Use the
      // raw page size (PAGE_SIZE) as the stop signal — loadMore will
      // fetch more until the DB itself stops returning data.
      hasMore.value = tracks.length >= PAGE_SIZE
      offset.value = PAGE_SIZE
    } catch (err) {
      if (token !== searchToken) return
      error.value = err instanceof Error ? err.message : "Search failed"
      rawTracks.value = []
    } finally {
      if (token === searchToken) isLoading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (!hasMore.value || isLoading.value) return
    const token = searchToken
    const pageOffset = offset.value
    try {
      const tracks = await fetchPage(pageOffset)
      if (token !== searchToken) return
      rawTracks.value = [...rawTracks.value, ...tracks]
      hasMore.value = tracks.length >= PAGE_SIZE
      offset.value = pageOffset + PAGE_SIZE
    } catch (err) {
      if (token !== searchToken) return
      error.value = err instanceof Error ? err.message : "Search failed"
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

  // Text input is debounced so fast typing / backspace doesn't spam
  // SQL on every keystroke. Filter chips run immediately — they fire
  // once per user gesture, no flood to worry about.
  const debouncedRun = useDebounceFn(() => runQuery(), 200)
  watch(query, () => {
    void debouncedRun()
  })

  // Persist + re-query on every filter change. Persistence ran fire-and-
  // forget before, so a storage-quota / plugin error meant the user saw
  // results filtered "as if" their choice had stuck — but the choice
  // silently reverted on next launch. Now any one persist failure
  // surfaces a single toast (we only want to bug the user once per
  // gesture, not five times) and the query still runs against the
  // in-memory selection.
  watch(
    filters,
    (next) => {
      void persistFilters(next)
      void runQuery()
    },
    { deep: true }
  )

  async function persistFilters(next: FiltersModel): Promise<void> {
    const writes = await Promise.allSettled([
      filtersStore.setAuthors(next.authors ?? []),
      filtersStore.setLanguages(next.languages ?? []),
      filtersStore.setLocations(next.locations ?? []),
      filtersStore.setDuration(next.duration ? [next.duration as DurationFilterId] : []),
      filtersStore.setSort(next.sort as "byReference" | "byDate" | undefined),
    ])
    if (writes.some((w) => w.status === "rejected")) {
      await toast.error(t("errors.filtersNotSaved"))
    }
  }

  const downloads = useDownloadStore()

  function toUiState(trackId: string, downloadState: DownloadState): UiTrackState {
    if (downloadState === "downloading") return "downloading"
    if (downloadState === "failed") return "failed"
    // In Search/library view, "downloaded locally" and "in playlist" both
    // surface as a single check ("added"). Two-checks ("completed") is
    // reserved for "listened to the end" — only meaningful on Home where
    // the playlist item carries `completedAt`.
    if (downloadState === "completed" || playlist.hasTrack(trackId)) return "added"
    return "none"
  }

  // Rows recompute reactively when the UI language changes so the
  // user sees localised author/location/source names the moment they
  // flip the toggle in Settings — no re-query needed.
  const rows = computed<readonly UiTrackRow[]>(() => {
    void downloads.states
    void downloads.progress
    void playlist.entries
    return rawTracks.value.map((track) => {
      const state = toUiState(track.id, downloads.getState(track.id))
      const progressPct = state === "downloading" ? downloads.getProgress(track.id) : 0
      return buildTrackRow(track, {
        preferredLanguage: appLanguage.value,
        authorsById: dictionaries.authorsById,
        locationsById: dictionaries.locationsById,
        sourcesById: dictionaries.sourcesById,
        state,
        progressPct,
      })
    })
  })

  const emptyMessage = computed(() => {
    if (isLoading.value) return ""
    if (!query.value.trim() && !activeFilters()) {
      return t("search.specifySearchCriteria")
    }
    return ""
  })

  const authorsItems = computed<SelectorDialogItem[]>(() =>
    dictionaries.authorsSorted.map((a) => ({
      id: a.id,
      title: a.names.get(appLanguage.value) ?? a.id,
    }))
  )

  const languagesItems = computed<SelectorDialogItem[]>(() =>
    dictionaries.languages.map((l) => ({ id: l.code, title: l.fullName }))
  )

  const locationsItems = computed<SelectorDialogItem[]>(() =>
    dictionaries.locationsSorted.map((l) => ({
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
    hasMore,
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
    loadMore,
  }
}
