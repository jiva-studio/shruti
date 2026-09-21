import { ref } from "vue"
import type { Author } from "@lib/domain/author.js"
import type { Location } from "@lib/domain/location.js"
import type { TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { formatReference } from "@lib/domain/services/references.js"
import { formatTrackDate } from "@lib/domain/services/trackDate.js"
import {
  resolveLocalizedName,
  resolveTrackTitle as resolveTitleForLang,
} from "@lib/domain/services/localizedName.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"

export interface NoteTrackContext {
  track?: Track
  author?: Author
  location?: Location
}

export interface UseNoteTrackContextReturn {
  /** Pass `force` when the underlying data may have moved (view entry, after a
   *  refresh); the filter-driven path relies on the id cache to stay quiet. */
  refreshTracks: (force?: boolean) => Promise<void>
  /** The content DB was asked about this track and had no row — the lecture is
   *  hidden or gone. Distinct from "not looked up yet", where the row must
   *  stay optimistic rather than flash a degraded card. */
  isTrackUnresolved: (trackId: TrackId) => boolean
  contextFor: (trackId: TrackId) => NoteTrackContext
  authorName: (author: Author | undefined) => string | undefined
  locationName: (location: Location | undefined) => string | undefined
  trackTitle: (track: Track | undefined) => string | undefined
  trackDate: (track: Track | undefined) => string | undefined
  reference: (track: Track | undefined) => string | undefined
}

/**
 * The lecture behind each note, joined to the notes currently on screen.
 *
 * The full match set is unbounded, so it is the rendered window that drives
 * the join. Authors and locations come from the dictionaries store, which is a
 * one-shot full load.
 */
export function useNoteTrackContext(
  rendered: () => readonly { trackId: string }[]
): UseNoteTrackContextReturn {
  const app = useShruti()
  const dictionaries = useDictionariesStore()
  const appLanguage = useAppLanguage()

  const tracksById = ref<ReadonlyMap<TrackId, Track>>(new Map())
  // Includes ids the content DB had no row for, so a narrowing filter is fully
  // covered by it and skips the roundtrip; paging in more rows widens it.
  const cachedTrackIds = ref<ReadonlySet<TrackId>>(new Set())

  function clear(): void {
    tracksById.value = new Map()
    cachedTrackIds.value = new Set()
  }

  async function refreshTracks(force = false): Promise<void> {
    const ids = Array.from(new Set(rendered().map((n) => n.trackId as TrackId)))
    if (ids.length === 0) {
      clear()
      return
    }
    if (!force && ids.every((id) => cachedTrackIds.value.has(id))) return
    try {
      tracksById.value = await app.repositories().tracks.getByIds(ids)
      cachedTrackIds.value = new Set(ids)
    } catch {
      clear()
    }
  }

  function isTrackUnresolved(trackId: TrackId): boolean {
    return cachedTrackIds.value.has(trackId) && !tracksById.value.has(trackId)
  }

  function contextFor(trackId: TrackId): NoteTrackContext {
    const track = tracksById.value.get(trackId)
    if (!track) return {}
    const author = track.authorId ? dictionaries.authorsById.get(track.authorId) : undefined
    const location = track.locationId ? dictionaries.locationsById.get(track.locationId) : undefined
    return { track, author, location }
  }

  return {
    refreshTracks,
    isTrackUnresolved,
    contextFor,
    authorName: (author) => resolveLocalizedName(author, appLanguage.value),
    locationName: (location) => resolveLocalizedName(location, appLanguage.value),
    trackTitle: (track) => resolveTitleForLang(track, appLanguage.value),
    // ExcerptCard prints whatever it is handed, so the localization is here.
    trackDate: (track) =>
      track?.date ? formatTrackDate(track.date, appLanguage.value) : undefined,
    reference: (track) =>
      track && track.references.length > 0
        ? formatReference(track.references[0]!, dictionaries.sourcesById, appLanguage.value)
        : undefined,
  }
}
