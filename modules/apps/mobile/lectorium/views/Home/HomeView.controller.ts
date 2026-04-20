import { computed, onMounted, ref, type ComputedRef, type Ref } from "vue"
import type { Author } from "@lib/domain/author.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { buildTrackRow } from "@lectorium/composables/buildTrackRow.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useDownloadStore, type DownloadState } from "@lectorium/stores/useDownloadStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks.list/index.js"

export interface HomeControllerReturn {
  rows: ComputedRef<readonly UiTrackRow[]>
  isLoading: ComputedRef<boolean>
  error: ComputedRef<string | null>
  refresh: () => Promise<void>
  onSelect: (trackId: string) => Promise<void>
  onRemove: (trackId: string) => Promise<void>
}

export function useHomeController(): HomeControllerReturn {
  const appLanguage = useAppLanguage()

  const app = useLectorium()
  const repos = app.repositories()
  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const downloads = useDownloadStore()

  // Dictionaries are loaded once (authors / locations / sources are small
  // and don't change during a session). Playlist items themselves come
  // from the shared store so Search-driven adds reflect immediately.
  const authorsById = ref<ReadonlyMap<string, Author>>(new Map())
  const locationsById = ref<ReadonlyMap<string, Location>>(new Map())
  const sourcesById = ref<ReadonlyMap<string, Source>>(new Map())

  async function loadDictionaries(): Promise<void> {
    const [authors, locations, sources] = await Promise.all([
      repos.authors.listAll(),
      repos.locations.listAll(),
      repos.sources.listAll(),
    ])
    authorsById.value = new Map(authors.map((a) => [a.id, a]))
    locationsById.value = new Map(locations.map((l) => [l.id, l]))
    sourcesById.value = new Map(sources.map((s) => [s.id, s]))
  }

  onMounted(async () => {
    await Promise.all([loadDictionaries(), playlist.ensureLoaded()])
    // Kick off prefetch for every track already in the playlist so the
    // download indicator reflects cache-hits from previous sessions.
    for (const { track } of playlist.entries) {
      const variant = track.variants.find((v) => v.audio)
      if (!variant?.audio) continue
      const url = app.storagePublicUrl.get(variant.audio.path)
      downloads.prefetch(track.id, url)
    }
  })

  function toUiState(
    trackId: string,
    downloadState: DownloadState
  ): UiTrackState {
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
        authorsById: authorsById.value,
        locationsById: locationsById.value,
        sourcesById: sourcesById.value,
        state: toUiState(track.id, downloads.getState(track.id)),
      })
    )
  })

  const isLoading = computed(() => playlist.isLoading)
  const error = computed(() => playlist.error)

  async function refresh(): Promise<void> {
    await playlist.refresh()
  }

  // Tap on a playlist item → start playback immediately. Matches legacy
  // behaviour: no detour into a track-detail page, no extra tap.
  async function onSelect(trackId: string): Promise<void> {
    const entry = playlist.entries.find((e) => e.track.id === trackId)
    if (!entry) return
    const author = entry.track.authorId
      ? authorsById.value.get(entry.track.authorId) ?? null
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

  return { rows, isLoading, error, refresh, onSelect, onRemove }
}
