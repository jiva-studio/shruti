import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { playTrack, type PlayTrackError } from "@lib/application/playTrack.js"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { Result } from "@lib/domain/result.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import { useConfig } from "@lectorium/composables/useConfig.js"

interface OpenArgs {
  readonly track: Track
  readonly preferredLanguage?: LanguageCode
  /** Optional — used only for the system-player "author" label. */
  readonly author?: Author | null
  /** Optional playlist-item id; wiring progress persistence can use it later. */
  readonly itemId?: string
}

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
  const autoOpenTranscript = useConfig<boolean>("settings.openTranscriptAutomatically", false)

  const trackId = ref<TrackId | null>(null)
  const title = ref<string>("")
  const authorName = ref<string>("")
  const language = ref<LanguageCode | null>(null)
  const playing = ref<boolean>(false)
  const positionMs = ref<number>(0)
  const durationMs = ref<number>(0)
  const itemId = ref<string | null>(null)

  const open = computed(() => trackId.value !== null)

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

    const remoteUrl = app.storagePublicUrl.get(cmd.audio.path)
    // Play from the local cache when available; `ensureDownloaded`
    // downloads-on-demand if the file isn't there yet, and returns
    // null on error so we gracefully fall back to streaming.
    const localUrl = await useDownloadStore().ensureDownloaded(cmd.trackId, remoteUrl)
    const url = localUrl ?? remoteUrl

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
      await app.audioPlayer.play()
    } catch {
      return { ok: false, error: "engine-failed" }
    }

    trackId.value = cmd.trackId
    title.value = cmd.title
    authorName.value = cmd.authorName
    language.value = cmd.language
    itemId.value = cmd.itemId
    positionMs.value = 0
    durationMs.value = cmd.audio.duration ?? 0

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
  }

  async function stop(): Promise<void> {
    if (!open.value) return
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
  }
})
