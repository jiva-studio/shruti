import { computed, onMounted, type ComputedRef } from "vue"
import { buildTrackRow } from "@lectorium/composables/buildTrackRow.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useDownloadStore, type DownloadState } from "@lectorium/stores/useDownloadStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks.list/index.js"

export interface HomeControllerReturn {
  rows: ComputedRef<readonly UiTrackRow[]>
  isLoading: ComputedRef<boolean>
  error: ComputedRef<string | null>
  hasMore: ComputedRef<boolean>
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  onSelect: (trackId: string) => Promise<void>
  onRemove: (trackId: string) => Promise<void>
}

export function useHomeController(): HomeControllerReturn {
  const appLanguage = useAppLanguage()

  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const downloads = useDownloadStore()
  const dictionaries = useDictionariesStore()

  onMounted(async () => {
    await Promise.all([dictionaries.ensureLoaded(), playlist.ensureLoaded(), downloads.hydrate()])
    playlist.prefetchAll()
  })

  function toUiState(trackId: string, downloadState: DownloadState): UiTrackState {
    if (player.trackId === trackId && player.playing) return "playing"
    switch (downloadState) {
      case "downloading":
        return "downloading"
      case "completed":
        return "completed"
      case "failed":
        return "failed"
      default:
        return "added"
    }
  }

  const rows = computed<readonly UiTrackRow[]>(() => {
    // Touch reactive state maps so the computed re-runs on download
    // progress and player transitions.
    void downloads.states
    void player.trackId
    void player.playing
    return playlist.entries.map(({ track }) =>
      buildTrackRow(track, {
        preferredLanguage: appLanguage.value,
        authorsById: dictionaries.authorsById,
        locationsById: dictionaries.locationsById,
        sourcesById: dictionaries.sourcesById,
        state: toUiState(track.id, downloads.getState(track.id)),
      })
    )
  })

  const isLoading = computed(() => playlist.isLoading)
  const error = computed(() => playlist.error)
  const hasMore = computed(() => playlist.hasMore)

  async function refresh(): Promise<void> {
    await playlist.refresh()
  }

  async function loadMore(): Promise<void> {
    await playlist.loadMore()
  }

  // Tap on a playlist item → start playback immediately. Matches legacy
  // behaviour: no detour into a track-detail page, no extra tap.
  async function onSelect(trackId: string): Promise<void> {
    const entry = playlist.entries.find((e) => e.track.id === trackId)
    if (!entry) return
    const author = entry.track.authorId
      ? (dictionaries.authorsById.get(entry.track.authorId) ?? null)
      : null
    await player.openTrack({
      track: entry.track,
      preferredLanguage: appLanguage.value,
      author,
    })
  }

  async function onRemove(trackId: string): Promise<void> {
    await playlist.archiveByTrackId(trackId)
  }

  return { rows, isLoading, error, hasMore, refresh, loadMore, onSelect, onRemove }
}
