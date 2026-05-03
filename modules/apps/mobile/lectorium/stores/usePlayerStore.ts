import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { playTrack, type PlayTrackError } from "@lib/application/playTrack.js"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { Result } from "@lib/domain/result.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useConfig } from "@lectorium/composables/useConfig.js"

interface OpenArgs {
  readonly track: Track
  readonly preferredLanguage?: LanguageCode
  /** Optional — used only for the system-player "author" label. */
  readonly author?: Author | null
  /** Required for progress persistence. Without it the player still
   *  works, but position is not saved or restored. */
  readonly itemId?: PlaylistItemId
  /** Resume position in milliseconds. Ignored when missing or near the
   *  end (treated as "completed; play from start"). */
  readonly resumeFromMs?: number | null
}

/** Persist position no more than once per N ms while playing. */
const PROGRESS_SAVE_INTERVAL_MS = 5000
/** Treat playback within this window of the end as "complete". */
const COMPLETION_THRESHOLD_MS = 2000

/**
 * Ambient player state. A singleton because there's only ever one audio
 * engine at a time. Views call `open(track)`; the floating player reads
 * `title/author/positionMs/durationMs/playing` reactively.
 *
 * The store subscribes to `IAudioPlayer.onProgress` lazily — the first
 * `open()` sets it up, and the unsubscribe handle lives for the app's
 * lifetime (no teardown; this is a root-level store).
 */
export const usePlayerStore = defineStore("player", () => {
  const app = useLectorium()
  const autoOpenTranscript = useConfig<boolean>("settings.openTranscriptAutomatically", true)

  const trackId = ref<TrackId | null>(null)
  const title = ref<string>("")
  const authorName = ref<string>("")
  const language = ref<LanguageCode | null>(null)
  const playing = ref<boolean>(false)
  const positionMs = ref<number>(0)
  const durationMs = ref<number>(0)
  const itemId = ref<PlaylistItemId | null>(null)

  const open = computed(() => trackId.value !== null)

  let lastSavedAt = 0
  let lastSavedMs = -1

  function maybePersistProgress(now: number, position: number, duration: number): void {
    if (!itemId.value) return
    const playlist = usePlaylistStore()

    // Auto-complete near the end. Persist `progress = duration` first
    // so the row renders as 100% even if `markCompleted` later fails or
    // races with an archive — otherwise the row would freeze at the
    // last throttled save (e.g. 95%) with no `completedAt`, which is
    // exactly the "stuck near 100%" indicator users complained about.
    if (duration > 0 && position >= duration - COMPLETION_THRESHOLD_MS) {
      void playlist.setProgress(itemId.value, duration)
      void playlist.markCompleted(itemId.value)
      lastSavedMs = position
      lastSavedAt = now
      return
    }

    if (now - lastSavedAt < PROGRESS_SAVE_INTERVAL_MS) return
    if (Math.abs(position - lastSavedMs) < 1000) return
    lastSavedAt = now
    lastSavedMs = position
    void playlist.setProgress(itemId.value, position)
  }

  function flushProgressNow(): void {
    if (!itemId.value) return
    lastSavedAt = Date.now()
    lastSavedMs = positionMs.value
    void usePlaylistStore().setProgress(itemId.value, positionMs.value)
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
      maybePersistProgress(Date.now(), status.position, status.duration)
    })
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

    // Switching to a different item: persist where we left the previous
    // one BEFORE we touch the engine. Awaited so the next time the user
    // hits the old row, `entry.item.progress` is already up to date —
    // otherwise a fast back-tap resumes from a stale snapshot (or zero).
    if (itemId.value && positionMs.value > 0) {
      await usePlaylistStore().setProgress(itemId.value, positionMs.value)
    }

    // Disarm the progress guard while we swap audio. Any emit between
    // `audioPlayer.open()` and the new `itemId.value` assignment below
    // could otherwise mark stale data on the new id.
    itemId.value = null

    // Play from the local cache when available; `ensureDownloaded`
    // downloads-on-demand if the file isn't there yet — including
    // runtime CDN fallback if the active server is degraded — and
    // returns null on total failure so we gracefully fall back to
    // streaming. The streaming URL is built AFTER the download
    // attempt so a runtime CDN promotion inside `ensureDownloaded`
    // is reflected in the stream-fallback URL too.
    const localUrl = await useDownloadStore().ensureDownloaded(cmd.trackId, cmd.audio.path)
    const url = localUrl ?? app.storagePublicUrl.get(cmd.audio.path)

    subscribeOnce()
    // Engine first; reactive state lands only on success. If `open` or
    // `play` rejects, callers see `engine-failed` and the floating
    // player keeps showing whatever was previously open (or stays
    // closed) instead of a phantom title for a track that never
    // started.
    try {
      await app.audioPlayer.open({
        itemId: cmd.itemId,
        url,
        title: cmd.title,
        author: cmd.authorName,
      })
      const duration = cmd.audio.duration ?? 0
      const resumeMs = pickResumeMs(args.resumeFromMs, duration)
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
    positionMs.value = pickResumeMs(args.resumeFromMs, durationMs.value)
    // Reset throttle so the first save reflects the resume point.
    lastSavedAt = 0
    lastSavedMs = positionMs.value

    // Legacy behaviour: when the user has opted in, the transcript
    // surfaces automatically on every new track — no extra tap required.
    if (autoOpenTranscript.value) {
      useTranscriptStore().show(cmd.trackId)
    }
    return { ok: true, value: undefined }
  }

  async function togglePause(): Promise<void> {
    if (!open.value) return
    await app.audioPlayer.togglePause()
    // Engine emit will land asynchronously; flush now so the saved
    // position reflects this user gesture even if the user closes the
    // app before the next throttled tick.
    flushProgressNow()
  }

  async function seek(ms: number): Promise<void> {
    if (!open.value) return
    // Clamp to a sane range before either the UI or the native plugin
    // sees it. NaN/Infinity from a misbehaving slider would otherwise
    // poison RadialProgress and the transcript scrub indicator.
    const safe = Number.isFinite(ms) ? ms : 0
    const upper = durationMs.value > 0 ? durationMs.value : safe
    const clamped = Math.max(0, Math.min(upper, safe))
    positionMs.value = clamped
    await app.audioPlayer.seek(clamped)
    // User-initiated seek should persist immediately rather than wait
    // for the next throttled tick.
    if (itemId.value) {
      lastSavedAt = Date.now()
      lastSavedMs = clamped
      void usePlaylistStore().setProgress(itemId.value, clamped)
    }
  }

  async function stop(): Promise<void> {
    if (!open.value) return
    // Snapshot the last known position before tearing down so the user
    // can resume where they left off on the next launch.
    if (itemId.value && positionMs.value > 0) {
      void usePlaylistStore().setProgress(itemId.value, positionMs.value)
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
  // If the saved position was within the completion window, treat it as
  // "finished" and start from the beginning instead of resuming on the
  // last few seconds of audio.
  if (durationMs > 0 && resumeFromMs >= durationMs - COMPLETION_THRESHOLD_MS) return 0
  return resumeFromMs
}
