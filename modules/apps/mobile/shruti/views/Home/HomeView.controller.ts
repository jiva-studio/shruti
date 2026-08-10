import { computed, onMounted, toRef, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useActivityHeatmap } from "@shruti/composables/useActivityHeatmap.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useReloadOnPlayback } from "@shruti/composables/useReloadOnPlayback.js"
import { useToast } from "@kit/composables"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { playbackErrorKey } from "@shruti/utils/playbackErrorKey.js"
import { useHomeRowBuilder } from "./useHomeRowBuilder.js"
import type { HeatmapDay } from "@usecases/activity/buildHeatmapDays.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"

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
 * Home shows the user's listening journey. Wires the playlist store +
 * heatmap composable to the view; row construction is delegated to
 * `useHomeRowBuilder`, heatmap polling to `useReloadOnPlayback`.
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

  const { rows, queueCount, queueTotalSeconds } = useHomeRowBuilder()

  onMounted(async () => {
    await Promise.all([
      dictionaries.ensureLoaded(),
      playlist.ensureLoaded(),
      downloads.hydrate(),
      heatmap.reload(),
    ])
    // (A downloads-hydrate failure is surfaced by the store itself now, so it
    // shows on whatever screen triggered the hydrate, not only Home.)
    // A dictionary load failure degrades silently otherwise — author /
    // location / topic labels render as raw ids or blanks and the Search
    // filters come up empty, with nothing telling the user why. Surface it.
    if (dictionaries.error) {
      void toast.error(t("errors.dictionariesUnavailable"))
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

    // A failed download on Home means the audio file isn't on disk.
    // Tapping should retry the download, NOT start streaming from CDN
    // (which is what `openTrack` would do via `localUrl ?? remoteUrl`
    // fallback). `ensureDownloaded` already does the cache probe first,
    // so it's equivalent to "check files, then download if missing".
    // Read through any in-flight `pending` claim: a claimed row reads
    // "pending" while still being the failed one that needs a retry, and
    // falling through here would stream from the CDN instead.
    if (downloads.getEffectiveState(trackId) === "failed") {
      const variant = entry.track.variants.find((v) => v.audio)
      if (variant?.audio) {
        // Pass the catalog size: without it the budget charges the corpus
        // average for a lecture it already knows the size of, which reads as
        // a device that fills up faster the more often you retry.
        void downloads.ensureDownloaded(trackId, variant.audio.path, variant.audio.filesize)
      }
      return
    }

    const author = entry.track.authorId
      ? (dictionaries.authorsById.get(entry.track.authorId) ?? null)
      : null
    // A refused open leaves the row looking tapped and nothing playing, and
    // the drain-event notice cannot cover it (see `syncFromNative`), so say
    // it here. Nothing gates a queued entry on having an audible variant, so
    // both refusals are reachable.
    const result = await player.openTrack({
      track: entry.track,
      preferredLanguage: appLanguage.value,
      author,
      itemId: entry.item.id,
    })
    if (!result.ok) void toast.error(t(playbackErrorKey(result.error)))
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
