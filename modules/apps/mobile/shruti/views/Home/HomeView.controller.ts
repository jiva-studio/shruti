import { computed, onMounted, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { buildTrackRow } from "@shruti/composables/buildTrackRow.js"
import { maxAudioDurationMs } from "@shruti/composables/trackDuration.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useToast } from "@shruti/services/useToast.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import type { Track } from "@lib/domain/track.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"

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

/**
 * Home shows the user's listening journey, not download status.
 *
 * State for each row collapses to one of three:
 *  - "playing"   — active player track (radial with playback %)
 *  - "completed" — listened to the end (double check)
 *  - "queued"    — everything else (radial with saved progress, or empty
 *                   ring when the user hasn't started the track yet)
 *
 * Download/added/failed indicators belong on the Library/Search list,
 * not here. Keep the mapping local so this rule lives next to the view
 * that enforces it.
 */
export function useHomeController(): HomeControllerReturn {
  const appLanguage = useAppLanguage()

  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const downloads = useDownloadStore()
  const dictionaries = useDictionariesStore()
  const toast = useToast()
  const { t } = useI18n()

  onMounted(async () => {
    await Promise.all([dictionaries.ensureLoaded(), playlist.ensureLoaded(), downloads.hydrate()])
    if (downloads.hydrationError) {
      void toast.error(t("errors.downloadsCacheUnavailable"))
    }
    playlist.prefetchAll()
  })

  function rowState(trackId: string, completedAt: number | null): UiTrackState {
    if (player.trackId === trackId) return "playing"
    if (completedAt !== null) return "completed"
    return "queued"
  }

  function rowProgressPct(track: Track, state: UiTrackState, savedProgress: number | null): number {
    if (state === "playing") {
      if (player.durationMs <= 0) return 0
      return Math.min(100, Math.max(0, (player.positionMs / player.durationMs) * 100))
    }
    if (state === "queued") {
      const duration = maxAudioDurationMs(track)
      const progress = savedProgress ?? 0
      if (duration <= 0) return 0
      return Math.min(100, Math.max(0, (progress / duration) * 100))
    }
    return 0
  }

  const rows = computed<readonly UiTrackRow[]>(() => {
    void player.trackId
    void player.positionMs
    void player.durationMs
    return playlist.entries.map(({ item, track }) => {
      const state = rowState(track.id, item.completedAt)
      const progressPct = rowProgressPct(track, state, item.progress)
      return buildTrackRow(track, {
        preferredLanguage: appLanguage.value,
        authorsById: dictionaries.authorsById,
        locationsById: dictionaries.locationsById,
        sourcesById: dictionaries.sourcesById,
        state,
        progressPct,
      })
    })
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
      itemId: entry.item.id,
      resumeFromMs: entry.item.progress,
    })
  }

  async function onRemove(trackId: string): Promise<void> {
    await playlist.archiveByTrackId(trackId)
  }

  return { rows, isLoading, error, hasMore, refresh, loadMore, onSelect, onRemove }
}
