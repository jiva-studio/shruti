import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { ILibraryItemRepository } from "@lib/domain/ports/libraryItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"

/**
 * A track lives in ONE of two sources: the shared **corpus** (content DB) or the
 * user's **personal library** (`library_items`, synced from the profile server).
 * They are two equal sources of the same domain type — a `Track` — so this
 * composite resolves a track BY ID from whichever holds it, and every resolver
 * in the app (playlist / Up Next / player / track sheet / share / prefetch)
 * keeps calling one `ITrackRepository` without knowing which source answered.
 *
 * Collection reads (`list` / `search` / `count` / `listYears` /
 * `findByReference`) target the corpus only — the personal library has its own
 * list surface and never participates in scripture-reference lookups. The
 * per-track transcript-path / language / duration reads consult both, sourcing
 * a library track's values from its single synthetic variant, so a user-added
 * lecture plays and shows its transcript through the same seams a corpus track
 * uses.
 */
export function createCompositeTrackRepository(
  corpus: ITrackRepository,
  library: ILibraryItemRepository
): ITrackRepository {
  return {
    async getById(id: TrackId): Promise<Track | null> {
      return (await corpus.getById(id)) ?? (await library.getTrackByTrackId(id))
    },

    async getByIds(ids: readonly TrackId[]): Promise<ReadonlyMap<TrackId, Track>> {
      const map = new Map(await corpus.getByIds(ids))
      // Ids the corpus didn't hold are resolved against the personal library.
      // There's no batch library API, but the remainder is small (a page of
      // playlist items).
      await Promise.all(
        ids
          .filter((id) => !map.has(id))
          .map(async (id) => {
            const t = await library.getTrackByTrackId(id)
            if (t) map.set(id, t)
          })
      )
      return map
    },

    list: (query) => corpus.list(query),
    search: (query) => corpus.search(query),
    count: (filters) => corpus.count(filters),
    listYears: () => corpus.listYears(),
    findByReference: (sourceId, tokens, languages) =>
      corpus.findByReference(sourceId, tokens, languages),

    async getTranscriptPath(trackId: TrackId, language: LanguageCode): Promise<string | null> {
      const path = await corpus.getTranscriptPath(trackId, language)
      if (path !== null) return path
      const t = await library.getTrackByTrackId(trackId)
      // Resolve the REQUESTED language's variant, not variants[0] — a bilingual
      // library track has one transcript per language.
      return t?.variants.find((v) => v.language === language)?.transcript?.path ?? null
    },

    async listTranscriptLanguages(trackId: TrackId): Promise<readonly LanguageCode[]> {
      const langs = await corpus.listTranscriptLanguages(trackId)
      if (langs.length > 0) return langs
      const t = await library.getTrackByTrackId(trackId)
      // Every variant that has a transcript is a selectable language.
      return (t?.variants ?? []).filter((v) => v.transcript).map((v) => v.language)
    },

    async getDurationsMs(trackIds: readonly TrackId[]): Promise<ReadonlyMap<TrackId, number>> {
      const map = new Map(await corpus.getDurationsMs(trackIds))
      await Promise.all(
        trackIds
          .filter((id) => !map.has(id))
          .map(async (id) => {
            const dur = (await library.getTrackByTrackId(id))?.variants[0]?.audio?.duration
            if (typeof dur === "number") map.set(id, dur)
          })
      )
      return map
    },
  }
}
