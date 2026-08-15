import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { useTimeoutFn } from "@vueuse/core"
import { dateRangeBounds } from "@lib/domain/dateFilters.js"
import type {
  DiscoveryFilter,
  DiscoveryHit,
  DiscoveryMessage,
  DiscoverySearchRequest,
} from "@lib/contracts"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"

/** One page. The server clamps anything above 100 and defaults to this. */
const PAGE_SIZE = 20

/**
 * How far paging can go before the service has nothing more to give.
 *
 * A text search fetches a fixed 60 candidates per lane, fuses them and slices
 * the page out of that — the same candidates whatever the offset. So the third
 * page is the last one that can be non-empty, and offering "more" past it
 * promises something that is not there.
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
   * False while another dock page has the screen (#1786).
   *
   * Distinct from `enabled`, and the distinction is the whole point: an empty
   * field means there is nothing to show and the lane is cleared, while being
   * covered means the words still stand and so does what was found for them.
   * A covered page asks nothing and keeps its shelf; it re-asks on return only
   * if the field or the filters changed while it was away.
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
 * model. The service can also READ a sentence into these same filter fields
 * ("Radhanath Swami 2019" becomes a speaker and a year) when they are sent as
 * `query` instead, but nothing asks for that: it is a model call per pause in
 * typing, and the field has no button that means "understand this".
 *
 * Failure here is never the surface's failure. The library lane is local and
 * always answers; the internet lane needs a network, a token and somebody
 * else's uptime, so it reports itself and leaves the rest of the page alone.
 */
export function useWebSearch(options: UseWebSearchOptions): UseWebSearchReturn {
  const app = useShruti()
  const appLanguage = useAppLanguage()
  const dictionaries = useDictionariesStore()

  const hits = ref<readonly DiscoveryHit[]>([])
  const messages = ref<readonly DiscoveryMessage[]>([])
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  const offset = ref<number>(0)
  const exhausted = ref<boolean>(true)

  // One search in flight. A keystroke that arrives mid-request abandons it
  // rather than queueing: nobody wants the answer to what they had typed
  // two letters ago, and the service is charged for it either way.
  let inFlight: AbortController | null = null
  let token = 0
  // The filter the last first-page search actually ran with, as the service
  // resolved it. Paging reuses it so page two continues page one.
  let resolved: DiscoveryFilter | null = null
  // What the shelf currently answers — the words and the facets a first page
  // was last asked for. Consulted when the page gets the screen back: what is
  // on it is already the answer unless one of them moved while it was covered.
  let asked: string | null = null

  const owned = computed(() => options.owned?.value ?? true)

  // The typing debounce, as a timer that can be called off. A search armed
  // while this page was on top must not go out after it has been covered — the
  // page on top asks the same words for itself and the service bills both. The
  // timer stops with the scope too, so a page torn down mid-word asks nothing.
  //
  // `isPending` is "a search is owed but has not started yet", and it counts as
  // loading: for those 400ms nothing is in flight and nothing has been found,
  // and a surface reading only `isLoading` reports "nothing found" mid-word.
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

  /**
   * The app's facets in the vocabulary the service speaks.
   *
   * Authors go as the name in the current UI language — what a person sees is
   * what gets asked for, and the service resolves spellings its archives use.
   * Sources go as the English short code from our own dictionary ("SB",
   * "CC Madhya"), which the canon resolves; the localized full name would work
   * in Russian and not in English, where the corpus writes diacritics no
   * archive uses. Locations, topics, tags, duration and sort have no
   * counterpart in the index at all and stay local to the library lane.
   */
  function facets(): DiscoveryFilter {
    const authors = (options.filters.value.authors ?? [])
      .map((id) => dictionaries.authorsById.get(id)?.names.get(appLanguage.value))
      .filter((n): n is string => !!n)
    const sources = (options.filters.value.sources ?? [])
      .map((id) => dictionaries.sourcesById.get(id)?.names.get("en")?.shortName)
      .filter((c): c is string => !!c)
    const languages = options.filters.value.languages ?? []
    // The facet is "YYYY" / "YYYY-MM"; the service wants whole ISO days, and
    // its upper bound is inclusive where dateRangeBounds' is not.
    const bounds = dateRangeBounds(options.filters.value.dateFrom, options.filters.value.dateTo)
    return {
      ...(authors.length ? { authors } : {}),
      ...(languages.length ? { languages: [...languages] } : {}),
      ...(sources.length ? { sources } : {}),
      ...(bounds.gte ? { date_from: bounds.gte } : {}),
      ...(bounds.lt ? { date_to: dayBefore(bounds.lt) } : {}),
    }
  }

  async function fetchPage(pageOffset: number): Promise<void> {
    const text = options.query.value.trim()
    if (!options.enabled.value || !text) {
      reset()
      return
    }
    // Nothing is asked on behalf of a page nobody is looking at. Every way in
    // here can arrive after the page was covered — a timer armed a moment
    // before the tap, a filter the sheet on top changed — and the page on top
    // is asking the same words itself. Paging is unaffected: `owned` is true
    // for the page whose "more" button was pressed.
    if (!owned.value) return
    inFlight?.abort()
    const controller = new AbortController()
    inFlight = controller
    const mine = ++token
    if (pageOffset === 0) asked = question()

    // A later page continues the search that produced the first one, using the
    // filter the service resolved and returned for exactly that purpose. A
    // first page starts from the facets.
    const base: DiscoveryFilter = pageOffset > 0 && resolved ? resolved : { ...facets(), text }
    const req: DiscoverySearchRequest = {
      filter: { ...base, limit: PAGE_SIZE, offset: pageOffset },
    }

    isLoading.value = true
    error.value = null
    try {
      const res = await app.discoveryClient.search(req, { signal: controller.signal })
      if (mine !== token) return
      hits.value = pageOffset === 0 ? res.hits : [...hits.value, ...res.hits]
      if (pageOffset === 0) resolved = res.filter
      messages.value = res.messages ?? []
      exhausted.value = res.hits.length < PAGE_SIZE
      offset.value = pageOffset + PAGE_SIZE
    } catch (err) {
      if (mine !== token || controller.signal.aborted) return
      // A first page that failed shows the error in place of the section; a
      // later page keeps what is already on screen and just stops offering
      // more.
      //
      // Nothing was found for these words, so they are not what the shelf
      // answers: leaving them memoized makes the watcher skip them forever and
      // the lane reads "unavailable" for words that would work, until the field
      // is cleared. Forgetting them cannot loop — the watcher only fires on the
      // query, the filters, `enabled` or `owned` changing, none of which a
      // failure touches.
      if (pageOffset === 0) {
        hits.value = []
        asked = null
      }
      exhausted.value = true
      error.value = err instanceof Error ? err.message : "Search failed"
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
      // and this shelf keeps what it found until it is looked at again. A
      // search that was owed is called off rather than left armed — 400ms is
      // long enough to type a word and tap a result, and the timer firing
      // afterwards would buy an answer for a page nobody is on.
      if (!owned.value) {
        unschedule()
        return
      }
      if (question() === asked) return
      schedule()
    },
    // A page opened with words already in the field searches for them; nothing
    // else is going to ask on its behalf.
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

/** The day before an exclusive upper bound, as `YYYY-MM-DD`. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
