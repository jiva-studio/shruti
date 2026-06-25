import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { LectureIndexEntry } from '@lib/catalog/types.js'
import type { Lang } from '../i18n/ui'
import { contentLangFor } from '../i18n/locales'

export interface FacetOption {
  id: string
  label: string
}

export type SortMode = 'newest' | 'oldest' | 'reference'

export interface SearchFilter {
  query: Ref<string>
  debounced: Ref<string>
  selectedAuthors: Ref<string[]>
  selectedLocations: Ref<string[]>
  selectedLanguages: Ref<string[]>
  yearFrom: Ref<string>
  yearTo: Ref<string>
  duration: Ref<string>
  sort: Ref<SortMode>
  authorOptions: ComputedRef<FacetOption[]>
  locationOptions: ComputedRef<FacetOption[]>
  languageOptions: ComputedRef<FacetOption[]>
  years: ComputedRef<string[]>
  filtered: ComputedRef<LectureIndexEntry[]>
  reset: () => void
}

// Each language's own name (endonym) — a language label isn't translated per
// UI locale.
const languageNames: Record<string, string> = { en: 'English', ru: 'Русский' }

function norm(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export function useSearchFilter(
  index: LectureIndexEntry[],
  lang: () => Lang
): SearchFilter {
  const query = ref('')
  const debounced = ref('')
  const selectedAuthors = ref<string[]>([])
  const selectedLocations = ref<string[]>([])
  // Default to the UI locale's content language (uk→ru, sr→en) so a visitor
  // sees the lectures they can actually read; they can broaden it.
  const selectedLanguages = ref<string[]>([contentLangFor(lang())])
  const yearFrom = ref('')
  const yearTo = ref('')
  const duration = ref('')
  const sort = ref<SortMode>('newest')

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  watch(query, (v) => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounced.value = v
    }, 150)
  })

  function pick(map: Record<string, string>): string {
    if (map[lang()]) return map[lang()]
    const first = Object.values(map)[0]
    return first ?? ''
  }

  function pickFrom(map: Record<string, string>): string {
    return pick(map) || Object.values(map)[0] || ''
  }

  function languageLabel(code: string): string {
    return languageNames[code] ?? code
  }

  const haystacks = new WeakMap<LectureIndexEntry, string>()
  function haystackFor(entry: LectureIndexEntry): string {
    const cached = haystacks.get(entry)
    if (cached !== undefined) return cached
    const parts: string[] = []
    for (const v of Object.values(entry.titles)) parts.push(v)
    for (const v of Object.values(entry.authorNames)) parts.push(v)
    for (const v of Object.values(entry.locationNames)) parts.push(v)
    for (const r of entry.refs) {
      for (const v of Object.values(r.shortNames)) parts.push(v)
      parts.push(r.tokens)
    }
    const h = norm(parts.join(' '))
    haystacks.set(entry, h)
    return h
  }

  const authorOptions = computed<FacetOption[]>(() => {
    const map = new Map<string, string>()
    for (const e of index) if (e.authorId && !map.has(e.authorId)) map.set(e.authorId, pickFrom(e.authorNames))
    return [...map].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
  })

  const locationOptions = computed<FacetOption[]>(() => {
    const map = new Map<string, string>()
    for (const e of index) if (e.locationId && !map.has(e.locationId)) map.set(e.locationId, pickFrom(e.locationNames))
    return [...map].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
  })

  const languageOptions = computed<FacetOption[]>(() => {
    const set = new Set<string>()
    for (const e of index) for (const c of e.contentLanguages) set.add(c)
    return [...set].sort().map((id) => ({ id, label: languageLabel(id) }))
  })

  const years = computed<string[]>(() => {
    const set = new Set<string>()
    for (const e of index) if (e.date) set.add(e.date.slice(0, 4))
    return [...set].sort((a, b) => b.localeCompare(a))
  })

  function refSortKey(e: LectureIndexEntry): string {
    const r = e.refs[0]
    if (!r) return ''
    const short = r.shortNames[contentLangFor(lang())] ?? Object.values(r.shortNames)[0] ?? ''
    return norm(`${short} ${r.tokens}`.trim())
  }

  function sortEntries(arr: LectureIndexEntry[]): LectureIndexEntry[] {
    const a = [...arr]
    if (sort.value === 'reference') {
      a.sort((x, y) => {
        const kx = refSortKey(x)
        const ky = refSortKey(y)
        if (!kx && !ky) return 0
        if (!kx) return 1
        if (!ky) return -1
        return kx.localeCompare(ky)
      })
      return a
    }
    const dir = sort.value === 'oldest' ? 1 : -1
    a.sort((x, y) => {
      if (!x.date && !y.date) return 0
      if (!x.date) return 1
      if (!y.date) return -1
      return x.date < y.date ? -dir : x.date > y.date ? dir : 0
    })
    return a
  }

  const filtered = computed<LectureIndexEntry[]>(() => {
    const tokens = norm(debounced.value).split(/\s+/).filter(Boolean)
    const yf = yearFrom.value
    const yt = yearTo.value
    const out = index.filter((e) => {
      if (tokens.length) {
        const h = haystackFor(e)
        for (const tok of tokens) if (!h.includes(tok)) return false
      }
      if (selectedAuthors.value.length && (!e.authorId || !selectedAuthors.value.includes(e.authorId))) return false
      if (selectedLocations.value.length && (!e.locationId || !selectedLocations.value.includes(e.locationId)))
        return false
      if (selectedLanguages.value.length && !e.contentLanguages.some((c) => selectedLanguages.value.includes(c)))
        return false
      if (yf || yt) {
        if (!e.date) return false
        const y = e.date.slice(0, 4)
        if (yf && y < yf) return false
        if (yt && y > yt) return false
      }
      if (duration.value) {
        if (e.durationMs == null) return false
        const m = e.durationMs
        if (duration.value === 'short' && !(m < 20 * 60000)) return false
        if (duration.value === 'medium' && !(m >= 20 * 60000 && m <= 60 * 60000)) return false
        if (duration.value === 'long' && !(m > 60 * 60000)) return false
      }
      return true
    })
    return sortEntries(out)
  })

  function reset() {
    query.value = ''
    debounced.value = ''
    selectedAuthors.value = []
    selectedLocations.value = []
    selectedLanguages.value = []
    yearFrom.value = ''
    yearTo.value = ''
    duration.value = ''
    sort.value = 'newest'
  }

  return {
    query,
    debounced,
    selectedAuthors,
    selectedLocations,
    selectedLanguages,
    yearFrom,
    yearTo,
    duration,
    sort,
    authorOptions,
    locationOptions,
    languageOptions,
    years,
    filtered,
    reset,
  }
}
