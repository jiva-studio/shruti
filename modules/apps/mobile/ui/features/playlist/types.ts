import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"

/**
 * Live playback of the ONE track the player is on, kept OUT of the row list so
 * a position tick can't invalidate it (issue #1504).
 *
 * Must be a single object with stable identity whose fields are reactive
 * per-field (the app passes a `reactive()` view of the player store): a row
 * reads `trackId` to find out whether it is the playing one, and only the row
 * that is reads `state` / `progressPct`. That conditional read is what keeps a
 * tick from touching any other row.
 */
export interface UiPlaybackProgress {
  /** Track currently open in the player, `null` when nothing is. */
  readonly trackId: string | null
  /** Row state for that track — "playing" until the pass reaches the end of a
   *  lecture already marked completed, at which point "completed". */
  readonly state: UiTrackState
  /** 0..100 live playback progress for that track. */
  readonly progressPct: number
}

/**
 * One rendered entry in the Home playlist: either a standalone track row or a
 * collapsible group of consecutive tracks added from the same collection.
 * Groups come from each item's stored `collectionId` provenance — set when the
 * user adds a whole collection (see usePlaylistGroups).
 */
export type PlaylistRenderItem =
  | { readonly kind: "track"; readonly row: UiTrackRow }
  | {
      readonly kind: "group"
      readonly id: string
      readonly name: string
      /** Dominant author across the group's lectures ("" when unknown), with an
       *  "…and others" suffix already applied when more than one author. */
      readonly author: string
      readonly rows: readonly UiTrackRow[]
    }
