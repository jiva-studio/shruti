import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { playTrack, type PlayTrackError } from "@lib/application/playTrack.js"
import { getProgressForItem } from "@lib/application/getProgressForItem.js"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { Result } from "@lib/domain/result.js"
import { useShruti } from "@shruti/shruti.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useListeningSessionTracker } from "@shruti/composables/useListeningSessionTracker.js"

interface OpenArgs {
  readonly track: Track
  readonly preferredLanguage?: LanguageCode
  /** Optional — used only for the system-player "author" label. */
  readonly author?: Author | null
  /** Required for progress persistence. Without it the player still
   *  works, but position is not saved or restored. */
  readonly itemId?: PlaylistItemId
  /** Resume position in milliseconds. When omitted, the store fetches
   *  it from `listening_sessions` for the given `itemId`. Pass `0` to
   *  start from the beginning regardless of saved progress. */
  readonly resumeFromMs?: number | null
}

/** Treat playback within this window of the end as "complete". */
const COMPLETION_THRESHOLD_MS = 2000

/**
 * Ambient player state. A singleton because there's only ever one audio
 * engine at a time. Views call `open(track)`; the floating player reads
 * `title/author/positionMs/durationMs/playing` reactively.
 *
 * Listening time is journaled in `listening_sessions` via
 * `useListeningSessionTracker`. The tracker opens a session on play,
 * ticks while playing, closes on pause/seek/track-change/visibility-hide.
 * The store's progress/completion state for the playlist UI is then
 * derived from those rows, not from a column on `playlist_items`.
 */
export const usePlayerStore = defineStore("player", () => {
  const app = useShruti()
  const autoOpenTranscript = useConfig<boolean>("settings.openTranscriptAutomatically", true)
  const tracker = useListeningSessionTracker({
    getRepo: () => app.repositories().listeningSessions,
  })

  const trackId = ref<TrackId | null>(null)
  const title = ref<string>("")
  const authorName = ref<string>("")
  const language = ref<LanguageCode | null>(null)
  const playing = ref<boolean>(false)
  const positionMs = ref<number>(0)
  const durationMs = ref<number>(0)
  const itemId = ref<PlaylistItemId | null>(null)

  const open = computed(() => trackId.value !== null)

  function patchPlaylistProgress(id: PlaylistItemId, ms: number): void {
    void usePlaylistStore().patchProgress(id, ms)
  }

  /**
   * Drive the session lifecycle from native progress events. The native
   * plugin emits ~once per second; the tracker throttles writes so we
   * persist at most every 15 s while playing.
   */
  function maybePersistProgress(position: number, duration: number): void {
    const id = itemId.value
    if (!id) return

    const reachedEnd = duration > 0 && position >= duration - COMPLETION_THRESHOLD_MS

    if (reachedEnd) {
      if (tracker.hasActiveSession()) {
        void tracker
          .finish({ positionMs: duration })
          .then(() => patchPlaylistProgress(id, duration))
      } else {
        patchPlaylistProgress(id, duration)
      }
      return
    }

    if (playing.value) {
      if (!tracker.hasActiveSession() || tracker.activeItemId() !== id) {
        void tracker.start({ itemId: id, positionMs: position })
      } else {
        void tracker.tick({ positionMs: position })
      }
    } else if (tracker.hasActiveSession()) {
      void tracker.finish({ positionMs: position }).then(() => patchPlaylistProgress(id, position))
    }
  }

  /** Best-effort flush before backgrounding/closing. */
  function flushProgressNow(): void {
    const id = itemId.value
    if (!id) return
    if (tracker.hasActiveSession()) {
      const pos = positionMs.value
      void tracker.flushOnHide({ positionMs: pos }).then(() => patchPlaylistProgress(id, pos))
    }
  }

  let subscribed = false
  function subscribeOnce(): void {
    if (subscribed) return
    subscribed = true
    app.audioPlayer.onProgress((status) => {
      // If the platform fires a late event from a previous track, ignore it.
      if (itemId.value !== null && status.itemId !== itemId.value) return
      playing.value = status.playing
      positionMs.value = status.position
      if (status.duration > 0) durationMs.value = status.duration
      maybePersistProgress(status.position, status.duration)
    })
  }

  async function resolveResumePositionMs(args: OpenArgs): Promise<number> {
    if (args.resumeFromMs !== undefined) {
      return Math.max(0, args.resumeFromMs ?? 0)
    }
    if (!args.itemId) return 0
    const sec = await getProgressForItem(args.itemId, {
      listeningSessions: app.repositories().listeningSessions,
    })
    return sec === null ? 0 : sec * 1000
  }

  async function openTrack(
    args: OpenArgs
  ): Promise<Result<void, PlayTrackError | "engine-failed">> {
    const plan = await playTrack({
      track: args.track,
      preferredLanguage: args.preferredLanguage,
      author: args.author,
      itemId: args.itemId,
    })
    if (!plan.ok) return plan
    const cmd = plan.value

    // Re-tap on the currently-loaded track/variant: don't reload audio,
    // engine position would be reset to 0. Just resume playback if paused.
    const sameItem =
      cmd.itemId === itemId.value &&
      cmd.trackId === trackId.value &&
      cmd.language === language.value
    if (sameItem) {
      subscribeOnce()
      if (!playing.value) {
        try {
          await app.audioPlayer.play()
        } catch {
          return { ok: false, error: "engine-failed" }
        }
      }
      return { ok: true, value: undefined }
    }

    // Switching to a different item: close out the previous session and
    // patch the playlist's progress map BEFORE we touch the engine, so a
    // fast back-tap to the old row sees the latest position.
    const prevItemId = itemId.value
    if (prevItemId && tracker.hasActiveSession()) {
      const prevPos = positionMs.value
      await tracker.finish({ positionMs: prevPos })
      patchPlaylistProgress(prevItemId, prevPos)
    }

    // Disarm the progress guard while we swap audio. Any emit between
    // `audioPlayer.open()` and the new `itemId.value` assignment below
    // could otherwise mark stale data on the new id.
    itemId.value = null

    const rawResumeMs = await resolveResumePositionMs(args)
    const duration = cmd.audio.duration ?? 0
    const resumeMs = pickResumeMs(rawResumeMs, duration)

    const localUrl = await useDownloadStore().ensureDownloaded(cmd.trackId, cmd.audio.path)
    const url = localUrl ?? app.storagePublicUrl.get(cmd.audio.path)

    subscribeOnce()
    try {
      await app.audioPlayer.open({
        itemId: cmd.itemId,
        url,
        title: cmd.title,
        author: cmd.authorName,
      })
      if (resumeMs > 0) {
        await app.audioPlayer.seek(resumeMs)
      }
      await app.audioPlayer.play()
    } catch {
      return { ok: false, error: "engine-failed" }
    }

    trackId.value = cmd.trackId
    title.value = cmd.title
    authorName.value = cmd.authorName
    language.value = cmd.language
    itemId.value = cmd.itemId
    durationMs.value = cmd.audio.duration ?? 0
    positionMs.value = resumeMs

    if (autoOpenTranscript.value) {
      useTranscriptStore().show(cmd.trackId)
    }
    return { ok: true, value: undefined }
  }

  async function togglePause(): Promise<void> {
    if (!open.value) return
    await app.audioPlayer.togglePause()
    // The engine emits playing=false → maybePersistProgress will close
    // the session on the next tick. Patch the playlist immediately so
    // the UI doesn't have to wait for a render-cycle round-trip.
    if (itemId.value) patchPlaylistProgress(itemId.value, positionMs.value)
  }

  async function seek(ms: number): Promise<void> {
    if (!open.value) return
    const safe = Number.isFinite(ms) ? ms : 0
    const upper = durationMs.value > 0 ? durationMs.value : safe
    const clamped = Math.max(0, Math.min(upper, safe))
    const before = positionMs.value
    positionMs.value = clamped
    await app.audioPlayer.seek(clamped)
    if (itemId.value) {
      await tracker.seek({
        itemId: itemId.value,
        positionBeforeMs: before,
        positionAfterMs: clamped,
        willKeepPlaying: playing.value,
      })
      patchPlaylistProgress(itemId.value, clamped)
    }
  }

  async function stop(): Promise<void> {
    if (!open.value) return
    const id = itemId.value
    if (id) {
      const pos = positionMs.value
      if (tracker.hasActiveSession()) {
        await tracker.finish({ positionMs: pos })
      }
      patchPlaylistProgress(id, pos)
    }
    await app.audioPlayer.stop()
    trackId.value = null
    itemId.value = null
    playing.value = false
    positionMs.value = 0
    durationMs.value = 0
  }

  return {
    trackId,
    title,
    authorName,
    language,
    playing,
    positionMs,
    durationMs,
    itemId,
    open,
    openTrack,
    togglePause,
    seek,
    stop,
    flushProgressNow,
  }
})

function pickResumeMs(resumeFromMs: number | null | undefined, durationMs: number): number {
  if (resumeFromMs == null || !Number.isFinite(resumeFromMs) || resumeFromMs <= 0) return 0
  if (durationMs > 0 && resumeFromMs >= durationMs - COMPLETION_THRESHOLD_MS) return 0
  return resumeFromMs
}
