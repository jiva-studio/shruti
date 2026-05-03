import { computed, onMounted, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { buildTrackRow } from "@lectorium/composables/buildTrackRow.js"
import { maxAudioDurationMs } from "@lectorium/composables/trackDuration.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useToast } from "@lectorium/services/useToast.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
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
 * Home shows the user's listening journey, NOT download status.
 *
 * Per-row state precedence (highest first):
 *  - "downloading" — active download (radial with download %).
 *  - "failed"      — download failed (warning icon).
 *  - "playing"     — currently-active player track (radial with playback %).
 *  - "completed"   — listened to the end (double check).
 *  - "queued"      — everything else, including a fully-downloaded track
 *                    that hasn't been played yet — empty/in-progress radial,
 *                    NOT the "added" checkmark. The checkmark belongs on
 *                    the Library / Search list, not Home.
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
    const dl = downloads.getState(trackId)
    if (dl === "downloading") return "downloading"
    if (dl === "failed") return "failed"
    if (player.trackId === trackId) return "playing"
    if (completedAt !== null) return "completed"
    return "queued"
  }

  function rowProgressPct(
    track: Track,
    trackId: string,
    state: UiTrackState,
    savedProgress: number | null
  ): number {
    if (state === "downloading") return downloads.getProgress(trackId)
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
    void downloads.states
    void downloads.progress
    return playlist.entries.map(({ item, track }) => {
      const state = rowState(track.id, item.completedAt)
      const progressPct = rowProgressPct(track, track.id, state, item.progress)
      // Dim + non-interactive while a download is in flight for this row
      // — the radial download indicator is showing, the row is "busy".
      const disabled = state === "downloading"
      return buildTrackRow(track, {
        preferredLanguage: appLanguage.value,
        authorsById: dictionaries.authorsById,
        locationsById: dictionaries.locationsById,
        sourcesById: dictionaries.sourcesById,
        state,
        progressPct,
        disabled,
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
