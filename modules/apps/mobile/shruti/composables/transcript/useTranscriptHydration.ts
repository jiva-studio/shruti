import { computed, ref, shallowRef, toValue, type MaybeRefOrGetter, type Ref } from "vue"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { IAuthorRepository } from "@lib/domain/ports/authorRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import type { Track } from "@lib/domain/track.js"

export interface UseTranscriptHydrationOptions {
  /**
   * Reactive UI language. Title and author display names are re-derived
   * from the cached domain entities whenever this value changes, so the
   * dialog updates without re-fetching when the user switches language.
   */
  preferredLanguage: MaybeRefOrGetter<LanguageCode>
  /** Resolved on each call so the composable can be constructed before the
   *  content DB is open (e.g. mounted at app root). */
  getRepos: () => {
    tracks: ITrackRepository
    authors: IAuthorRepository
    transcripts: ITranscriptRepository
  }
}

export interface UseTranscriptHydrationReturn {
  title: Ref<string>
  author: Ref<string>
  /** The hydrated author domain entity (for the system-player label when
   *  starting playback from the transcript). `null` until resolved. */
  authorEntity: Readonly<Ref<Author | null>>
  /**
   * The hydrated domain `Track`, exposed so consumers can read
   * track-level fields not surfaced as separate refs (date, location id,
   * references). `null` until `hydrate` resolves.
   */
  track: Readonly<Ref<Track | null>>
  availableLanguages: Ref<readonly LanguageCode[]>
  /** Active selection (mutable). Defaults to the preferred language when present. */
  activeLanguages: Ref<readonly LanguageCode[]>
  /** Loads track metadata + advertised transcript languages for the given id. */
  hydrate: (trackId: TrackId) => Promise<void>
  /** Restores the empty/initial state when no track is selected. */
  reset: () => void
}

/**
 * Loads the metadata that surrounds a transcript: track title (in the
 * preferred language with fallback), author display name, and the list of
 * available transcript languages. State is exposed as plain refs so the
 * caller decides when to display it.
 *
 * Title and author are kept reactive against `preferredLanguage` by
 * caching the resolved `Track` and `Author` entities and re-deriving the
 * localized strings via `computed`. This means switching UI language while
 * the dialog is open instantly relabels the header — no extra repo calls.
 */
export function useTranscriptHydration(
  options: UseTranscriptHydrationOptions
): UseTranscriptHydrationReturn {
  // shallowRef: domain entities embed ReadonlyMap fields (`names`,
  // `variants`...). Deep reactivity isn't needed (entities are replaced
  // wholesale on hydrate) and a shallow ref keeps iteration semantics on
  // the maps intact.
  const trackEntity = shallowRef<Track | null>(null)
  const authorEntity = shallowRef<Author | null>(null)
  const availableLanguages = ref<readonly LanguageCode[]>([])
  const activeLanguages = ref<readonly LanguageCode[]>([]) as Ref<readonly LanguageCode[]>

  const title = computed<string>(() => {
    const track = trackEntity.value
    if (!track) return ""
    const lang = toValue(options.preferredLanguage)
    const variant = track.variants.find((v) => v.language === lang) ?? track.variants[0]
    return variant?.title ?? ""
  })

  const author = computed<string>(() => {
    const track = trackEntity.value
    const authorIdFallback = track?.authorId ?? ""
    const a = authorEntity.value
    if (!a) {
      // Either the track has no author, or the entity wasn't found in the
      // repo. Match the original fallback chain: when an authorId exists
      // but the entity is missing, surface the id so the dialog isn't
      // visually blank.
      return authorIdFallback
    }
    const lang = toValue(options.preferredLanguage)
    return a.names.get(lang) ?? a.names.values().next().value ?? authorIdFallback
  })

  async function hydrate(trackId: TrackId): Promise<void> {
    const repos = options.getRepos()
    const track = await repos.tracks.getById(trackId)
    trackEntity.value = track ?? null

    if (track?.authorId) {
      authorEntity.value = (await repos.authors.getById(track.authorId)) ?? null
    } else {
      authorEntity.value = null
    }

    availableLanguages.value = await repos.transcripts.availableLanguages(trackId)
    const lang = toValue(options.preferredLanguage)
    const firstActive =
      availableLanguages.value.find((l) => l === lang) ?? availableLanguages.value[0]
    activeLanguages.value = firstActive ? [firstActive] : []
  }

  function reset(): void {
    trackEntity.value = null
    authorEntity.value = null
    availableLanguages.value = []
    activeLanguages.value = []
  }

  return {
    title,
    author,
    authorEntity: authorEntity as Readonly<Ref<Author | null>>,
    track: trackEntity as Readonly<Ref<Track | null>>,
    availableLanguages,
    activeLanguages,
    hydrate,
    reset,
  }
}
