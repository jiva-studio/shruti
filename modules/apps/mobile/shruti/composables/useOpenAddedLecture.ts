import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { useOpenLibraryItem } from "@shruti/composables/useOpenLibraryItem.js"

export interface OpenAddedLecture {
  /** Whether this source URL resolves to a lecture there is somewhere to open. */
  canOpen: (url: string | undefined) => boolean
  /** Open it on the track sheet. No-op when it resolves to nothing. */
  open: (url: string | undefined) => void
}

/**
 * A lecture the user added, addressed by the URL it came from.
 *
 * Chat offers one, search finds one, and both hand back the same object once it
 * has been added: a personal-library item, opened on the sheet the library tile
 * opens. Matching is by source URL — the key the add path already uses — and
 * the answer to "is there anything behind this tile" is asked here rather than
 * assumed from a status, because a tile that cannot be opened must not claim to
 * be a button (#1788).
 *
 * Shaped like `useIngestStatusFor` (url in, answer out) so a renderer walking a
 * list of candidates can call it per item.
 */
export function useOpenAddedLecture(): OpenAddedLecture {
  const library = useLibraryStore()
  const openLibraryItem = useOpenLibraryItem()

  // `hasSource` is the ACTIVE-library check (a removed lecture is offered
  // again, not opened); `findBySource` then hands over the row itself.
  function itemFor(url: string | undefined) {
    if (!url || !library.hasSource(url)) return undefined
    const item = library.findBySource(url)
    return item?.status === "ready" && item.trackId ? item : undefined
  }

  return {
    canOpen: (url) => itemFor(url) !== undefined,
    open: (url) => {
      const item = itemFor(url)
      if (item) openLibraryItem(item)
    },
  }
}
