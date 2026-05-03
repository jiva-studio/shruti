import { computed, onMounted, toRef, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { buildTrackRow } from "@lectorium/composables/buildTrackRow.js"
import { maxAudioDurationMs } from "@lectorium/composables/trackDuration.js"
import { useActivityHeatmap } from "@lectorium/composables/useActivityHeatmap.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useReloadOnPlayback } from "@lectorium/composables/useReloadOnPlayback.js"
import { useToast } from "@lectorium/services/useToast.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import type { HeatmapDay } from "@lib/application/buildHeatmapDays.js"
import type { Track } from "@lib/domain/track.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"

export interface HomeControllerReturn {
  rows: ComputedRef<readonly UiTrackRow[]>
  isLoading: ComputedRef<boolean>
  error: ComputedRef<string | null>
  hasMore: ComputedRef<boolean>
  queueCount: ComputedRef<number>
  queueTotalSeconds: ComputedRef<number>
  heatmapDays: Ref<readonly HeatmapDay[]>
  currentStreak: Ref<number>
  completedCount: Ref<number>
  totalListenedSeconds: Ref<number>
  reloadHeatmap: () => Promise<void>
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
  const heatmap = useActivityHeatmap()

  onMounted(async () => {
    await Promise.all([
      dictionaries.ensureLoaded(),
      playlist.ensureLoaded(),
      downloads.hydrate(),
      heatmap.reload(),
    ])
    if (downloads.hydrationError) {
      void toast.error(t("errors.downloadsCacheUnavailable"))
    }
    playlist.prefetchAll()
  })

  // Refresh the heatmap whenever playback ends — covers pause, track-end,
  // and stop. The seconds spent listening land in the cell for "today",
  // so the user sees their progress without having to leave and re-enter
  // the screen. While playback is in progress, also poll every minute so
  // the user sees today's cell tick up in near-real-time during long
  // listens — session writes happen every 15s, but a UI reload that
  // often would be wasteful.
  useReloadOnPlayback(toRef(player, "playing"), heatmap.reload)

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
    savedProgressMs: number
  ): number {
    if (state === "downloading") return downloads.getProgress(trackId)
    if (state === "playing") {
      if (player.durationMs <= 0) return 0
      return Math.min(100, Math.max(0, (player.positionMs / player.durationMs) * 100))
    }
    if (state === "queued") {
      const duration = maxAudioDurationMs(track)
      if (duration <= 0) return 0
      return Math.min(100, Math.max(0, (savedProgressMs / duration) * 100))
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
      const completedAt = playlist.getCompletedAt(item.id)
      const state = rowState(track.id, completedAt)
      const savedProgressMs =
        player.itemId === item.id ? player.positionMs : playlist.getProgressMs(item.id)
      const progressPct = rowProgressPct(track, track.id, state, savedProgressMs)
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

  // Queue summary for the "Up Next" header badges — counts only
  // lectures the user hasn't finished yet, and sums their REMAINING
  // duration. Already-completed entries can linger in the list for a
  // while; they shouldn't inflate the "still to listen" count.
  const queueCount = computed(() => {
    let count = 0
    for (const { item } of playlist.entries) {
      if (playlist.getCompletedAt(item.id) === null) count++
    }
    return count
  })
  const queueTotalSeconds = computed(() => {
    let total = 0
    for (const { item, track } of playlist.entries) {
      if (playlist.getCompletedAt(item.id) !== null) continue
      const durMs = maxAudioDurationMs(track)
      if (durMs <= 0) continue
      const progressMs = playlist.getProgressMs(item.id)
      const remainingMs = Math.max(0, durMs - progressMs)
      total += Math.floor(remainingMs / 1000)
    }
    return total
  })

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
    })
  }

  async function onRemove(trackId: string): Promise<void> {
    await playlist.archiveByTrackId(trackId)
  }

  return {
    rows,
    isLoading,
    error,
    hasMore,
    queueCount,
    queueTotalSeconds,
    heatmapDays: heatmap.days,
    currentStreak: heatmap.currentStreak,
    completedCount: heatmap.completedCount,
    totalListenedSeconds: heatmap.totalListenedSeconds,
    reloadHeatmap: heatmap.reload,
    refresh,
    loadMore,
    onSelect,
    onRemove,
  }
}
