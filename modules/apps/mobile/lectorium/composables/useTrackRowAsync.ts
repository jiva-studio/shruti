import { onMounted, ref, watch, type Ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import type { Author } from "@lib/domain/author.js"
import type { AuthorId, LocationId, SourceId, TrackId } from "@lib/domain/core.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import type { Track } from "@lib/domain/track.js"

type Repositories = ReturnType<ReturnType<typeof useLectorium>["repositories"]>

interface TrackRowData {
  readonly track: Track
  readonly author: Author | null
  readonly location: Location | null
  readonly sourcesById: Map<string, Source>
}

/** The four-call cascade. `null` when the track itself is unknown. */
async function loadTrackRow(repos: Repositories, trackId: TrackId): Promise<TrackRowData | null> {
  const track = await repos.tracks.getById(trackId)
  if (!track) return null

  const sourceIds = Array.from(
    new Set(track.references.map((r) => r.sourceId).filter((id): id is string => Boolean(id)))
  )
  const [author, location, sources] = await Promise.all([
    track.authorId ? repos.authors.getById(track.authorId as AuthorId) : Promise.resolve(null),
    track.locationId
      ? repos.locations.getById(track.locationId as LocationId)
      : Promise.resolve(null),
    Promise.all(sourceIds.map((id) => repos.sources.getById(id as SourceId))),
  ])

  const sourcesById = new Map<string, Source>()
  for (const source of sources) {
    if (source) sourcesById.set(source.id, source as Source)
  }
  return {
    track,
    author: (author as Author | null) ?? null,
    location: (location as Location | null) ?? null,
    sourcesById,
  }
}

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
  const app = useLectorium()

  const track = ref<Track | null>(null)
  const author = ref<Author | null>(null)
  const location = ref<Location | null>(null)
  const sourcesById = ref<Map<string, Source>>(new Map())
  const loading = ref(true)
  const error = ref(false)

  // Sequence token: the trackId can swap (chat re-render, list virtualization
  // reuse) while a load is in flight. Only the latest reload may write the
  // refs, otherwise an older resolve lands last and shows track A's data under
  // track B's id.
  let gen = 0

  function apply(data: TrackRowData | null): void {
    if (!data) {
      track.value = null
      author.value = null
      location.value = null
      sourcesById.value = new Map()
      error.value = true
      return
    }
    track.value = data.track
    author.value = data.author
    location.value = data.location
    sourcesById.value = data.sourcesById
  }

  async function reload(): Promise<void> {
    const myGen = ++gen
    const trackId = getTrackId()
    loading.value = true
    error.value = false
    try {
      const data = await loadTrackRow(app.repositories(), trackId as TrackId)
      if (myGen !== gen) return
      apply(data)
    } catch (err) {
      if (myGen !== gen) return
      console.warn("useTrackRowAsync: failed to load", err)
      error.value = true
    } finally {
      if (myGen === gen) loading.value = false
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
