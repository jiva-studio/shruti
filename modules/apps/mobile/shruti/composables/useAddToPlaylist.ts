import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"

export interface UseAddToPlaylistReturn {
  /** Idempotent: adding a track that's already in the playlist is a no-op. */
  addToPlaylist: (trackId: string) => Promise<void>
}

/**
 * Adds a track to the playlist. The row's UI state flips to "added"
 * via the playlist store, which is the user-facing feedback — no toast.
 */
export function useAddToPlaylist(): UseAddToPlaylistReturn {
  const playlist = usePlaylistStore()

  async function addToPlaylist(trackId: string): Promise<void> {
    await playlist.add(trackId)
  }

  return { addToPlaylist }
}
