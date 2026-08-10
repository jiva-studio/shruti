import type { TrackId } from "../core.js"
import type { LibraryItem } from "../libraryItem.js"
import type { Track } from "../track.js"

/**
 * Port over the personal-library membership rows (`library_items`, epic #1236).
 * The collection is **server-owned and pull-only** — the sync engine applies the
 * `profile` server's version and the app never authors a row — so this port
 * exposes reads only (no add/remove; those are server-authored actions triggered
 * over the chat/add transport in #1229), plus the local wipe.
 */
export interface ILibraryItemRepository {
  getById(id: string): Promise<LibraryItem | null>
  /** Resolve the membership row for a content hash, or `null`. */
  getByTrackId(trackId: TrackId): Promise<LibraryItem | null>
  /** All items, newest-first — the "My library" shelf/list source. */
  listAll(): Promise<readonly LibraryItem[]>
  /**
   * Synthetic {@link Track} for a user-added lecture keyed by its content hash,
   * or `null` when the track isn't in the personal library / has no content
   * hash yet. This is the seam that lets the existing playback stack (storage
   * URL resolver, download store, transcript loader) consume a user track
   * unchanged.
   */
  getTrackByTrackId(trackId: TrackId): Promise<Track | null>

  /**
   * Drop every projected item — the local data-wipe path (#1496). Required for
   * the wipe to be coherent rather than merely partial: removals live in the
   * sibling `library_memberships` table where ABSENCE MEANS ACTIVE, so clearing
   * that table while these rows stay puts every item the user had removed back
   * on the shelf.
   */
  clearAll(): Promise<void>
}
