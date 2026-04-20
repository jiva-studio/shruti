import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"
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

function pickVariantWithAudio(
  track: Track,
  preferred: LanguageCode | undefined
): TrackVariant | null {
  if (preferred) {
    const v = track.variants.find((x) => x.language === preferred && x.audio)
    if (v) return v
  }
  return track.variants.find((v) => v.audio) ?? null
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

  async function openTrack(args: OpenArgs): Promise<void> {
    const variant = pickVariantWithAudio(args.track, args.preferredLanguage)
    if (!variant || !variant.audio) {
      throw new Error(`Track ${args.track.id} has no audio`)
    }
    const remoteUrl = app.storagePublicUrl.get(variant.audio.path)
    // Play from the local cache when available; `ensureDownloaded`
    // downloads-on-demand if the file isn't there yet, and returns
    // null on error so we gracefully fall back to streaming.
    const localUrl = await useDownloadStore().ensureDownloaded(args.track.id, remoteUrl)
    const url = localUrl ?? remoteUrl
    const nextItemId = args.itemId ?? `track:${args.track.id}`

    subscribeOnce()
    trackId.value = args.track.id
    title.value = variant.title
    authorName.value =
      args.author?.names.get(variant.language) ??
      args.author?.names.values().next().value ??
      ""
    language.value = variant.language
    itemId.value = nextItemId
    positionMs.value = 0
    durationMs.value = variant.audio.duration ?? 0

    await app.audioPlayer.open({
      itemId: nextItemId,
      url,
      title: variant.title,
      author: authorName.value,
    })
    await app.audioPlayer.play()

    // Legacy behaviour: when the user has opted in, the transcript
    // surfaces automatically on every new track — no extra tap required.
    if (autoOpenTranscript.value) {
      useTranscriptStore().show(args.track.id)
    }
  }

  async function togglePause(): Promise<void> {
    if (!open.value) return
    await app.audioPlayer.togglePause()
  }

  async function seek(ms: number): Promise<void> {
    if (!open.value) return
    positionMs.value = ms
    await app.audioPlayer.seek(ms)
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
