import { ref, type Ref } from "vue"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { IAuthorRepository } from "@lib/domain/ports/authorRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"

export interface UseTranscriptHydrationOptions {
  preferredLanguage: LanguageCode
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
 */
export function useTranscriptHydration(
  options: UseTranscriptHydrationOptions
): UseTranscriptHydrationReturn {
  const title = ref<string>("")
  const author = ref<string>("")
  const availableLanguages = ref<readonly LanguageCode[]>([])
  const activeLanguages = ref<readonly LanguageCode[]>([]) as Ref<readonly LanguageCode[]>

  async function hydrate(trackId: TrackId): Promise<void> {
    const repos = options.getRepos()
    const track = await repos.tracks.getById(trackId)
    const variant = track
      ? (track.variants.find((v) => v.language === options.preferredLanguage) ?? track.variants[0])
      : null
    title.value = variant?.title ?? ""

    if (track?.authorId) {
      const a = await repos.authors.getById(track.authorId)
      author.value =
        a?.names.get(options.preferredLanguage) ?? a?.names.values().next().value ?? track.authorId
    } else {
      author.value = ""
    }

    availableLanguages.value = await repos.transcripts.availableLanguages(trackId)
    const firstActive =
      availableLanguages.value.find((l) => l === options.preferredLanguage) ??
      availableLanguages.value[0]
    activeLanguages.value = firstActive ? [firstActive] : []
  }

  function reset(): void {
    title.value = ""
    author.value = ""
    availableLanguages.value = []
    activeLanguages.value = []
  }

  return { title, author, availableLanguages, activeLanguages, hydrate, reset }
}
