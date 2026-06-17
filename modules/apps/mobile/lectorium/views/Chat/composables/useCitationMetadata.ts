import { computed, ref, watch, type ComputedRef } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import {
  preferredContentLanguage,
  resolveLocalizedName,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import { formatReference } from "@lib/domain/services/references.js"
import type { AuthorId, LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Author } from "@lib/domain/author.js"
import type { Track } from "@lib/domain/track.js"

/** Resolved, UI-localized attribution for one cited track — the same
 *  fields `CitationCard.vue` renders, in a flat shape the markdown export
 *  can drop straight into its source line. */
export interface CitationMeta {
  readonly trackTitle: string
  readonly authorName: string
  readonly reference: string
  readonly trackDate: string
}

/**
 * Resolve attribution metadata (title / author / reference / date) for a
 * set of cited tracks, keyed by `trackId`. Mirrors the async repo load +
 * formatting that `CitationCard.vue` does per card, but for every cite in
 * a message at once — so `ChatMessageBubble` can build the copy/share
 * export synchronously off a reactive map.
 *
 * Tracks are loaded once and cached raw; the formatted map is a computed
 * over `lang` + the sources dictionary, so a language switch re-localizes
 * without re-fetching. A track absent from the local catalog simply
 * yields empty fields (the export then falls back to the marker caption).
 */
export function useCitationMetadata(
  trackIds: () => readonly string[],
  lang: () => string
): ComputedRef<Map<string, CitationMeta>> {
  const app = useLectorium()
  const libraryLanguages = useLibraryLanguages()
  const dictionaries = useDictionariesStore()

  // Raw, language-agnostic loads cached per trackId. `undefined` value =
  // load in flight; an entry with a null track = load resolved to "not
  // found" (don't retry it on every token re-parse).
  const rawById = ref<Map<string, { track: Track | null; author: Author | null }>>(new Map())
  const inFlight = new Set<string>()

  async function load(trackId: string): Promise<void> {
    if (inFlight.has(trackId) || rawById.value.has(trackId)) return
    inFlight.add(trackId)
    try {
      const repos = app.repositories()
      const track = (await repos.tracks.getById(trackId as TrackId)) ?? null
      const author =
        track && track.authorId
          ? ((await repos.authors.getById(track.authorId as AuthorId)) ?? null)
          : null
      const next = new Map(rawById.value)
      next.set(trackId, { track, author })
      rawById.value = next
    } catch (err) {
      console.warn("[useCitationMetadata] load failed", trackId, err)
    } finally {
      inFlight.delete(trackId)
    }
  }

  watch(
    () => trackIds(),
    (ids) => {
      void dictionaries.ensureLoaded()
      for (const id of new Set(ids)) void load(id)
    },
    { immediate: true }
  )

  return computed<Map<string, CitationMeta>>(() => {
    const lc = lang() as LanguageCode
    const out = new Map<string, CitationMeta>()
    for (const [id, { track, author }] of rawById.value.entries()) {
      const first = track?.references?.[0]
      // Title follows the content language (the library language the track has),
      // not the UI language `lc` — which still drives author / reference labels.
      const contentLang = track
        ? (preferredContentLanguage(track, libraryLanguages.value, lc) ?? lc)
        : lc
      out.set(id, {
        trackTitle: resolveTrackTitle(track, contentLang) ?? "",
        authorName: resolveLocalizedName(author, lc) ?? "",
        reference: first ? formatReference(first, dictionaries.sourcesById, lc) : "",
        trackDate: track?.date || "",
      })
    }
    return out
  })
}
