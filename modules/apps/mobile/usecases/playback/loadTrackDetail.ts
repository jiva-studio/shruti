import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { IAuthorRepository } from "@lib/domain/ports/authorRepository.js"
import type { ILibraryItemRepository } from "@lib/domain/ports/libraryItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import type { Track } from "@lib/domain/track.js"
import { libraryItemToTrack } from "@lib/domain/libraryItem.js"
import { err, ok, type Result } from "@kit/core"

export interface LoadTrackDetailInput {
  readonly trackId: TrackId
}

export interface LoadTrackDetailDeps {
  readonly tracks: ITrackRepository
  readonly authors: IAuthorRepository
  readonly transcripts: ITranscriptRepository
  /** Personal-library fallback: a user-added lecture is NOT in the corpus
   *  `tracks` table, so resolve it as a synthetic Track from `library_items`. */
  readonly libraryItems: ILibraryItemRepository
}

export type LoadTrackDetailError = "not-found"

export interface TrackDetail {
  readonly track: Track
  readonly author: Author | null
  readonly availableLanguages: readonly LanguageCode[]
  /** Raw author/location for a personal-library track whose catalog ids are
   *  unresolved — the view shows these when there is no `author` entity /
   *  resolved location. Null for corpus tracks. */
  readonly authorRaw: string | null
  readonly locationRaw: string | null
}

/**
 * Load the data the Track view needs to render: the track itself, its
 * referring author (when one is set), and the list of languages it has
 * a transcript in.
 *
 * Returns `not-found` when the track id doesn't resolve so the view can
 * branch into an error state without try/catch. Author lookup and
 * transcript-language lookup never fail this use case — a track without
 * an author is rendered with `author: null`, and a track without
 * transcripts gets an empty list.
 *
 * Pulled out of TrackView's controller so the orchestration is
 * testable in isolation and the view stops directly importing
 * `@lib/domain/{author,track}` for fetch chains.
 */
export async function loadTrackDetail(
  input: LoadTrackDetailInput,
  deps: LoadTrackDetailDeps
): Promise<Result<TrackDetail, LoadTrackDetailError>> {
  // Corpus first; fall back to the personal library (a user-added lecture has
  // a content hash that isn't in the corpus `tracks` table).
  const corpusTrack = await deps.tracks.getById(input.trackId)
  const libraryItem = corpusTrack ? null : await deps.libraryItems.getByTrackId(input.trackId)
  const track = corpusTrack ?? (libraryItem ? libraryItemToTrack(libraryItem) : null)
  if (!track) return err("not-found")

  // Author + transcript languages are independent — fetch in parallel.
  const [author, availableLanguages] = await Promise.all([
    track.authorId ? deps.authors.getById(track.authorId) : Promise.resolve(null),
    deps.transcripts.availableLanguages(input.trackId),
  ])

  return ok({
    track,
    author,
    availableLanguages,
    authorRaw: libraryItem?.authorRaw ?? null,
    locationRaw: libraryItem?.locationRaw ?? null,
  })
}
