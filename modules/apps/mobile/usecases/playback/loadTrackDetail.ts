import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { IAuthorRepository } from "@lib/domain/ports/authorRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import type { Track } from "@lib/domain/track.js"
import { err, ok, type Result } from "@kit/core"

export interface LoadTrackDetailInput {
  readonly trackId: TrackId
}

export interface LoadTrackDetailDeps {
  readonly tracks: ITrackRepository
  readonly authors: IAuthorRepository
  readonly transcripts: ITranscriptRepository
}

export type LoadTrackDetailError = "not-found"

export interface TrackDetail {
  readonly track: Track
  readonly author: Author | null
  readonly availableLanguages: readonly LanguageCode[]
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
  const track = await deps.tracks.getById(input.trackId)
  if (!track) return err("not-found")

  // Author + transcript languages are independent — fetch in parallel.
  const [author, availableLanguages] = await Promise.all([
    track.authorId ? deps.authors.getById(track.authorId) : Promise.resolve(null),
    deps.transcripts.availableLanguages(input.trackId),
  ])

  return ok({ track, author, availableLanguages })
}
