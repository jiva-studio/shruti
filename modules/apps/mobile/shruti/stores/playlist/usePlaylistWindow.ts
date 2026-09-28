import { computed, ref, type ComputedRef, type Ref } from "vue"
import type { PlaylistEntry } from "@usecases/playlist/listPlaylistTracks.js"

export interface PlaylistWindowReturn {
  /** The whole active playlist. The native queue and every by-id lookup read
   *  this, since they outlive the rendered window. */
  readonly all: Ref<readonly PlaylistEntry[]>
  /** The window of `all` Home has rendered so far. */
  readonly rendered: Ref<readonly PlaylistEntry[]>
  readonly hasMore: ComputedRef<boolean>
  /** Replace the list, keeping whatever the user has already paged in: a
   *  refresh also fires mid-playback, and snapping a scrolled Home back to the
   *  first page is a jump. */
  replace(next: readonly PlaylistEntry[]): void
  clear(): void
  /** Render one more page of the already-loaded list. */
  widen(): void
}

export function usePlaylistWindow(pageSize: number): PlaylistWindowReturn {
  const all = ref<readonly PlaylistEntry[]>([])
  const rendered = ref<readonly PlaylistEntry[]>([])
  const hasMore = computed(() => rendered.value.length < all.value.length)

  function replace(next: readonly PlaylistEntry[]): void {
    all.value = next
    rendered.value = next.slice(0, Math.max(pageSize, rendered.value.length))
  }

  function clear(): void {
    all.value = []
    rendered.value = []
  }

  function widen(): void {
    const from = rendered.value.length
    rendered.value = [...rendered.value, ...all.value.slice(from, from + pageSize)]
  }

  return { all, rendered, hasMore, replace, clear, widen }
}
