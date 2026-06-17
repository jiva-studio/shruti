import type { UiTrackRow } from "@ui/components/tracks/list/index.js"

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
