import { computed, type ComputedRef } from "vue"
import { useSearchFiltersStore } from "@shruti/stores/useSearchFiltersStore.js"
import type { LanguageCode } from "@lib/domain/core.js"

/**
 * The user's chosen **library content languages** — the single source of truth
 * for which lectures are shown across the whole app (search, topics,
 * recommendations, similar). Decoupled from the UI language: a Russian-speaking
 * user can read a Russian UI while still choosing English lectures, and a UI
 * locale with no audio of its own (uk, sr, …) is seeded to a language we do have.
 *
 * Backed by the persisted search language facet (`useSearchFiltersStore`), so
 * the search filter sheet and the Settings → Library section edit the same set.
 * An empty set means "no language filter" (show everything) — a safe fallback,
 * though the UI enforces at least one.
 *
 * Triggers the store's lazy hydration; the returned ref updates reactively as
 * the persisted snapshot loads and as the user changes the selection.
 */
export function useLibraryLanguages(): ComputedRef<readonly LanguageCode[]> {
  const store = useSearchFiltersStore()
  void store.load()
  return computed(() => store.languageCodes as readonly LanguageCode[])
}
