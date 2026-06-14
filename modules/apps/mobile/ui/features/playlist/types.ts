import type { UiTrackRow } from "@ui/components/tracks/list/index.js"

/**
 * One rendered entry in the Home playlist: either a standalone track row or a
 * collapsible group of consecutive tracks that belong to the same collection.
 * Groups are derived at render time from collection membership — no per-item
 * provenance is stored (see usePlaylistGroups).
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
