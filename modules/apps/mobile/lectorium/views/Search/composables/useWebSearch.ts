import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { useTimeoutFn } from "@vueuse/core"
import type {
  DiscoveryFilter,
  DiscoveryHit,
  DiscoveryMessage,
  DiscoverySearchRequest,
  DiscoverySearchResponse,
} from "@lib/contracts"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { buildDiscoveryFilter } from "./discoveryFacets.js"

/** One page. The server clamps anything above 100 and defaults to this. */
const PAGE_SIZE = 20

/**
 * How far paging can go. A text search fetches a fixed 60 candidates per lane
 * and slices the page out of that, whatever the offset — so the third page is
 * the last one that can be non-empty.
 */
const MAX_OFFSET = 40

/** Debounce for typing. Long enough that a word is one search, not five. */
const TYPING_DEBOUNCE_MS = 400

export interface UseWebSearchOptions {
  query: Ref<string>
  filters: Ref<FiltersModel>
  /** False while the surface is not showing results — nothing is searched. */
  enabled: Ref<boolean>
  /**
   * False while another dock page has the screen. Distinct from `enabled`: an
   * empty field clears the lane, while being covered keeps what was found and
   * re-asks on return only if the field or the filters moved meanwhile.
   */
  owned?: Ref<boolean>
}

export interface UseWebSearchReturn {
  hits: Ref<readonly DiscoveryHit[]>
  /** What the service said about the request beyond the recordings: a speaker
   *  it does not know, a field the sentence overruled. */
  messages: Ref<readonly DiscoveryMessage[]>
  isLoading: Ref<boolean>
  /** True only for the first page, so paging doesn't blank the list. */
  isLoadingFirstPage: ComputedRef<boolean>
  error: Ref<string | null>
  hasMore: ComputedRef<boolean>
  loadMore: () => Promise<void>
}

/**
 * The "found on the internet" lane: lectures indexed on archives we do not own.
 *
 * The words go over as `filter.text` — searched as written, one embedding, no
 * model. Sending them as `query` instead would have the service read a
 * sentence into the filter fields, but that is a model call per pause in
 * typing and nothing on the surface asks for it.
 *
 * Failure here is never the surface's failure: the library lane is local and
 * always answers, so this one reports itself and leaves the page alone.
 */
export function useWebSearch(options: UseWebSearchOptions): UseWebSearchReturn {
  const app = useLectorium()
  const appLanguage = useAppLanguage()
  const dictionaries = useDictionariesStore()

  const hits = ref<readonly DiscoveryHit[]>([])
  const messages = ref<readonly DiscoveryMessage[]>([])
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  const offset = ref<number>(0)
  const exhausted = ref<boolean>(true)

  // One search in flight; a keystroke mid-request abandons it rather than
  // queueing, and the service is charged either way.
  let inFlight: AbortController | null = null
  let token = 0
  // The filter the last first-page search actually ran with, as the service
  // resolved it. Paging reuses it so page two continues page one.
  let resolved: DiscoveryFilter | null = null
  // The words and facets the shelf currently answers. Consulted when the page
  // gets the screen back: what is on it is already the answer unless one of
  // them moved while it was covered.
  let asked: string | null = null

  const owned = computed(() => options.owned?.value ?? true)

  // The typing debounce, as a timer that can be called off: a search armed
  // before the page was covered must not go out afterwards. `isPending` counts
  // as loading — for those 400ms a surface reading only `isLoading` would
  // report "nothing found" mid-word.
  const {
    isPending: pending,
    start: schedule,
    stop: unschedule,
  } = useTimeoutFn(() => void fetchPage(0), TYPING_DEBOUNCE_MS, { immediate: false })

  function question(): string {
    return JSON.stringify([options.query.value.trim(), options.filters.value])
  }

  const isLoadingFirstPage = computed(
    () => (isLoading.value || pending.value) && hits.value.length === 0
  )
  const hasMore = computed(() => !exhausted.value && offset.value < MAX_OFFSET)

  function facets(): DiscoveryFilter {
    const f = options.filters.value
    return buildDiscoveryFilter({
      authors: (f.authors ?? [])
        .map((id) => dictionaries.authorsById.get(id)?.names.get(appLanguage.value))
        .filter((n): n is string => !!n),
      languages: f.languages ?? [],
      sources: (f.sources ?? [])
        .map((id) => dictionaries.sourcesById.get(id)?.names.get("en")?.shortName)
        .filter((c): c is string => !!c),
      dateFrom: f.dateFrom,
      dateTo: f.dateTo,
    })
  }

  function beginRequest(): AbortController {
    inFlight?.abort()
    const controller = new AbortController()
    inFlight = controller
    return controller
  }

  // A later page continues the search that produced the first one, using the
  // filter the service resolved for exactly that purpose.
  function requestFilter(pageOffset: number, text: string): DiscoveryFilter {
    if (pageOffset > 0 && resolved) return resolved
    return { ...facets(), text }
  }

  function applyPage(res: DiscoverySearchResponse, pageOffset: number): void {
    hits.value = pageOffset === 0 ? res.hits : [...hits.value, ...res.hits]
    if (pageOffset === 0) resolved = res.filter
    messages.value = res.messages ?? []
    exhausted.value = res.hits.length < PAGE_SIZE
    offset.value = pageOffset + PAGE_SIZE
  }

  // A first page that failed shows the error in place of the section; a later
  // page keeps what is on screen and stops offering more. The failed words are
  // forgotten rather than memoized, or the watcher would skip them forever and
  // the lane would read "unavailable" for words that work.
  function applyFailure(err: unknown, pageOffset: number): void {
    if (pageOffset === 0) {
      hits.value = []
      asked = null
    }
    exhausted.value = true
    error.value = err instanceof Error ? err.message : "Search failed"
  }

  async function fetchPage(pageOffset: number): Promise<void> {
    const text = options.query.value.trim()
    if (!options.enabled.value || !text) {
      reset()
      return
    }
    // Nothing is asked on behalf of a page nobody is looking at: every way in
    // here can arrive after the page was covered, and the page on top asks the
    // same words itself. Paging is unaffected — `owned` is true for the page
    // whose "more" button was pressed.
    if (!owned.value) return
    const controller = beginRequest()
    const mine = ++token
    if (pageOffset === 0) asked = question()

    const req: DiscoverySearchRequest = {
      filter: { ...requestFilter(pageOffset, text), limit: PAGE_SIZE, offset: pageOffset },
    }

    isLoading.value = true
    error.value = null
    try {
      const res = await app.discoveryClient.search(req, { signal: controller.signal })
      if (mine === token) applyPage(res, pageOffset)
    } catch (err) {
      if (mine === token && !controller.signal.aborted) applyFailure(err, pageOffset)
    } finally {
      if (mine === token) isLoading.value = false
    }
  }

  function reset(): void {
    inFlight?.abort()
    unschedule()
    token++
    hits.value = []
    messages.value = []
    resolved = null
    error.value = null
    offset.value = 0
    exhausted.value = true
    isLoading.value = false
    asked = null
  }

  watch(
    [options.query, options.enabled, owned],
    () => {
      if (!options.enabled.value || !options.query.value.trim()) {
        reset()
        return
      }
      // Covered by a page that reads the same field: it searches for itself,
      // and a search that was owed here is called off rather than left armed.
      if (!owned.value) {
        unschedule()
        return
      }
      if (question() === asked) return
      schedule()
    },
    // A page opened with words already in the field searches for them.
    { immediate: true }
  )

  // A filter change is one gesture, not a stream of them — run it at once,
  // unless a search is already owed: that one reads the filters when it goes.
  watch(
    options.filters,
    () => {
      if (!options.enabled.value || !owned.value || !options.query.value.trim()) return
      if (pending.value) return
      void fetchPage(0)
    },
    { deep: true }
  )

  return {
    hits,
    messages,
    isLoading,
    isLoadingFirstPage,
    error,
    hasMore,
    loadMore: () => (hasMore.value ? fetchPage(offset.value) : Promise.resolve()),
  }
}
