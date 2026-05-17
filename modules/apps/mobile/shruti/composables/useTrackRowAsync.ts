import { onMounted, ref, watch, type Ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
import type { Author } from "@lib/domain/author.js"
import type { AuthorId, LocationId, SourceId, TrackId } from "@lib/domain/core.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import type { Track } from "@lib/domain/track.js"

export interface TrackRowAsyncRefs {
  readonly track: Ref<Track | null>
  readonly author: Ref<Author | null>
  readonly location: Ref<Location | null>
  readonly sourcesById: Ref<Map<string, Source>>
  readonly loading: Ref<boolean>
  readonly error: Ref<boolean>
  /** Imperative reload — re-runs the cascade. UI doesn't expose retry
   *  affordances yet but callers (mostly tests) can trigger it. */
  readonly reload: () => Promise<void>
}

/**
 * Reactive loader for the four-call cascade two chat cards
 * (`TrackMiniRow` and `LectureCard`) used to inline:
 *   1. tracks.getById        — the track itself
 *   2. authors.getById       — author dictionary entry
 *   3. locations.getById     — location dictionary entry
 *   4. Promise.all(sources)  — every source referenced by the track
 *
 * Both components ended up with identical 35-line `load()` functions and
 * five `ref()`s each. Extracting it keeps each card a thin presenter +
 * lets future consumers (a search-result card, a notes-page track
 * preview) hit one shared loader.
 *
 * Returns plain Vue refs so the caller can pass them into `computed()`,
 * `watch()`, or templates exactly the same way the old inline state
 * worked — no API change at the call site beyond destructuring.
 *
 * Auto-runs on mount AND on every change to `getTrackId()` (so a card
 * that gets a new track_id via prop swap reloads without the caller
 * wiring `watch` themselves).
 */
export function useTrackRowAsync(getTrackId: () => string): TrackRowAsyncRefs {
  const app = useShruti()

  const track = ref<Track | null>(null)
  const author = ref<Author | null>(null)
  const location = ref<Location | null>(null)
  const sourcesById = ref<Map<string, Source>>(new Map())
  const loading = ref(true)
  const error = ref(false)

  async function reload(): Promise<void> {
    const trackId = getTrackId()
    loading.value = true
    error.value = false
    try {
      const repos = app.repositories()
      const trk = await repos.tracks.getById(trackId as TrackId)
      if (!trk) {
        track.value = null
        author.value = null
        location.value = null
        sourcesById.value = new Map()
        error.value = true
        return
      }
      track.value = trk
      const sourceIds = Array.from(
        new Set(trk.references.map((r) => r.sourceId).filter((id): id is string => Boolean(id)))
      )
      const [au, loc, sources] = await Promise.all([
        trk.authorId ? repos.authors.getById(trk.authorId as AuthorId) : Promise.resolve(null),
        trk.locationId
          ? repos.locations.getById(trk.locationId as LocationId)
          : Promise.resolve(null),
        Promise.all(sourceIds.map((id) => repos.sources.getById(id as SourceId))),
      ])
      author.value = (au as Author | null) ?? null
      location.value = (loc as Location | null) ?? null
      const sourceMap = new Map<string, Source>()
      for (const s of sources) {
        if (s) sourceMap.set(s.id, s as Source)
      }
      sourcesById.value = sourceMap
    } catch (err) {
      console.warn("useTrackRowAsync: failed to load", err)
      error.value = true
    } finally {
      loading.value = false
    }
  }

  onMounted(() => {
    void reload()
  })
  watch(getTrackId, () => {
    void reload()
  })

  return { track, author, location, sourcesById, loading, error, reload }
}
