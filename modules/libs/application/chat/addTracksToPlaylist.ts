import type { TrackId } from "@lib/domain/core.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export type AddTracksToPlaylistError = "empty-tracks" | "playlist-add-failed"

export interface AddTracksToPlaylistInput {
  readonly trackIds: readonly TrackId[]
}

export interface PlaylistAdder {
  /**
   * Add one track to the active playlist. Implementations treat
   * "already in playlist" as success — the post-state ("the track IS
   * in the playlist") is what we care about. Throw or return a
   * rejected promise only for true persistence failures.
   */
  add(trackId: TrackId): Promise<unknown>
}

export interface AddTracksToPlaylistDeps {
  readonly playlist: PlaylistAdder
}

/**
 * Add a batch of tracks to the active playlist sequentially, surfacing
 * the first hard failure as a Result error. Sequential rather than
 * concurrent because the underlying repo is single-writer (SQLite).
 *
 * Invoked from the chat store when the user confirms a
 * `create_playlist` action card.
 */
export async function addTracksToPlaylist(
  input: AddTracksToPlaylistInput,
  deps: AddTracksToPlaylistDeps
): Promise<Result<void, AddTracksToPlaylistError>> {
  if (input.trackIds.length === 0) return err("empty-tracks")
  for (const trackId of input.trackIds) {
    try {
      await deps.playlist.add(trackId)
    } catch {
      return err("playlist-add-failed")
    }
  }
  return ok(undefined as void)
}
