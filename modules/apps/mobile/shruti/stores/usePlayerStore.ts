import { defineStore } from "pinia"
import { computed, onScopeDispose, ref, watch } from "vue"
import { App, type AppState } from "@capacitor/app"
import { playTrack, type PlayTrackError } from "@lib/application/playTrack.js"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { Result } from "@kit/core"
import type { AudioQueueItem } from "@ports/app/audioPlayer.js"
import { useShruti } from "@shruti/shruti.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useAutoPlayNext } from "@shruti/composables/useAutoPlayNext.js"
import { registerAudioSource } from "@shruti/composables/useAudioOrchestrator.js"
import { usePlayerResumePosition } from "./player/usePlayerResumePosition.js"
import { usePlayerSession } from "./player/usePlayerSession.js"
import { usePlayerQueueReconcile } from "./player/usePlayerQueueReconcile.js"

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

/**
 * Ambient player state. A singleton because there's only ever one audio
 * engine at a time. Views call `open(track)`; the floating player reads
 * `title/author/positionMs/durationMs/playing` reactively.
 *
 * Listening time is journaled in `listening_sessions` via the
 * `usePlayerSession` composable (which wraps `useListeningSessionTracker`
 * and binds it to the player's reactive state). Resume position is
 * resolved by `usePlayerResumePosition`. The store keeps the reactive
 * shape and the `openTrack/togglePause/seek/stop` orchestration.
 */
export const usePlayerStore = defineStore("player", () => {
  const app = useShruti()
  const autoOpenTranscript = useConfig<boolean>("settings.openTranscriptAutomatically", false)
  const autoPlayNext = useAutoPlayNext()
  const reconcile = usePlayerQueueReconcile()

  // True while a multi-track native queue (continuous playback) is loaded.
  // Off for the single-track `open()` path, so the existing single-track
  // semantics are untouched when the Pro toggle is off.
  let queueActive = false
  // The queue items currently handed to the engine, kept so we can resync
  // the FloatingPlayer's title/author when native auto-advances under us.
  let currentQueue: AudioQueueItem[] = []
  // Single-flight guard for the native-state drain (init / resume /
  // foreground-advance can all trigger it near-simultaneously).
  let syncing = false

  const trackId = ref<TrackId | null>(null)
  const title = ref<string>("")
  const authorName = ref<string>("")
  const language = ref<LanguageCode | null>(null)
  const playing = ref<boolean>(false)
  const positionMs = ref<number>(0)
  const durationMs = ref<number>(0)
  const itemId = ref<PlaylistItemId | null>(null)

  /**
   * Stereo-mix slider position. Persisted globally so the user's choice
   * survives app restarts and follows them across tracks.
   *
   *   −1 — both ears hear the original (left channel) only
   *    0 — mix OFF: native stereo (different content per ear)
   *   +1 — both ears hear the translation (right channel) only
   *
   * Anything strictly off-zero engages the mono-mix processor.
   */
  const mixPosition = useConfig<number>("settings.audio.mixPosition", 0)
  const mixEnabled = computed(() => mixPosition.value !== 0)
  const mixRatio = computed(() => clamp01((mixPosition.value + 1) / 2))

  /**
   * Playback speed (1.0 = normal). Engines preserve pitch. Persisted
   * globally so the user's speed choice survives app restarts and
   * follows them across tracks.
   */
  const playbackSpeed = useConfig<number>("settings.audio.playbackSpeed", 1.0)

  const SKIP_DELTA_MS = 15000

  const open = computed(() => trackId.value !== null)

  function patchPlaylistProgress(id: PlaylistItemId, ms: number): void {
    // Pass the engine-reported `durationMs` so `patchProgress` can mark
    // completion for items that live past the first paged window of the
    // playlist (where `entries.find(...)` wouldn't see them).
    void usePlaylistStore().patchProgress(id, ms, durationMs.value)
  }

  const session = usePlayerSession({
    itemIdRef: itemId,
    playingRef: playing,
    positionMsRef: positionMs,
    patchPlaylistProgress,
  })
  const resumePosition = usePlayerResumePosition()

  let unsubscribeProgress: (() => void) | null = null
  function subscribeOnce(): void {
    if (unsubscribeProgress) return
    unsubscribeProgress = app.audioPlayer.onProgress((status) => {
      // Ignore events when no track is loaded (mid-swap or pre-open). The
      // swap path nulls `itemId.value` BEFORE awaiting
      // `session.finishCurrent`, so this guard rejects in-flight events.
      if (itemId.value === null) return
      if (status.itemId !== itemId.value) {
        // A different item is playing than the one we think is current.
        // In queue mode this is the native engine auto-advancing under a
        // suspended/foregrounded JS — reconcile the finished item and move
        // our identity onto the new one. Outside queue mode it's a late
        // event from a previous track and is ignored.
        if (queueActive) void syncFromNative()
        return
      }
      playing.value = status.playing
      positionMs.value = status.position
      if (status.duration > 0) durationMs.value = status.duration
      session.applyStatus(status.position, status.duration)
    })
  }
  // Tear down the platform listener when the store scope is disposed.
  // In production the store is app-singleton so this rarely fires; the
  // observable wins are HMR (Vite re-evaluates the module) and Vitest
  // (each test creates a fresh pinia) — without this, every reload
  // accumulates a duplicate listener writing into the new store's refs.
  onScopeDispose(() => {
    unsubscribeProgress?.()
    unsubscribeProgress = null
    appStateHandle?.remove()
    appStateHandle = null
  })

  /**
   * Move the player's reactive identity onto a queue item the native
   * engine advanced to. Pulls title/author from the queue metadata
   * (correct lock-screen labels) and the rest from the playlist entry.
   */
  async function resyncTo(
    id: PlaylistItemId,
    positionMsValue: number,
    durationMsValue: number,
    isPlaying: boolean
  ): Promise<void> {
    const entry = usePlaylistStore().getEntryByItemId(id)
    if (!entry) return
    // Close out the previous item's session before swapping identity, the
    // same handoff `openTrack` does. In the foreground the live completion
    // path usually closed it already; this is a safety net.
    const prevItemId = itemId.value
    const prevPositionMs = positionMs.value
    itemId.value = null
    if (prevItemId && prevItemId !== id) {
      await session.finishCurrent(prevItemId, prevPositionMs)
    }
    const plan = await playTrack({
      track: entry.track,
      preferredLanguage: language.value ?? undefined,
      itemId: id,
    })
    if (!plan.ok) return
    const cmd = plan.value
    const meta = currentQueue.find((q) => q.itemId === id)
    trackId.value = cmd.trackId
    title.value = meta?.title ?? cmd.title
    authorName.value = meta?.author ?? cmd.authorName
    language.value = cmd.language
    durationMs.value = durationMsValue > 0 ? durationMsValue : (cmd.audio.duration ?? 0)
    positionMs.value = positionMsValue
    playing.value = isPlaying
    itemId.value = id
  }

  /**
   * Drain the native queue's transition journal into listening history,
   * then resync the FloatingPlayer to whatever the engine is now playing.
   * Runs on foreground auto-advance, on app resume, and once at startup —
   * the startup drain is what recovers progress for a queue that played
   * out (and possibly got killed) entirely in the background.
   */
  async function syncFromNative(): Promise<void> {
    if (syncing) return
    syncing = true
    try {
      const s = await app.audioPlayer.getQueueState()
      await reconcile.reconcileAndAck(s.events)
      if (s.currentItemId && s.currentItemId !== itemId.value) {
        await resyncTo(s.currentItemId, s.positionMs, s.durationMs, s.playing)
      } else if (s.currentItemId === null && queueActive) {
        // Queue ran dry — nothing playing. Don't show a stale "playing".
        playing.value = false
        queueActive = false
        currentQueue = []
      }
    } catch {
      // Best-effort — a drain failure must not break playback.
    } finally {
      syncing = false
    }
  }

  // Drain on every foreground resume (the background queue may have
  // advanced/finished while JS was suspended) and once at startup.
  let appStateHandle: { remove: () => void } | null = null
  void App.addListener("appStateChange", (state: AppState) => {
    if (state.isActive) void syncFromNative()
  }).then((h) => {
    appStateHandle = h
  })
  void syncFromNative()

  /** Push the current slider state to the engine. Called on every
   *  slider change and right after `audioPlayer.open()`, since a fresh
   *  MediaItem / AVPlayerItem loses the processor / tap binding. */
  function applyMix(): void {
    void app.audioPlayer.setMix({
      enabled: mixEnabled.value,
      ratio: mixRatio.value,
    })
  }
  watch(mixPosition, applyMix)

  /** Push playback speed to the engine. Same re-apply contract as the
   *  mix: native MediaItems / AVPlayerItems lose the rate setting on
   *  every open(), and on iOS pause→play also drops it. */
  function applyPlaybackSpeed(): void {
    void app.audioPlayer.setPlaybackRate(playbackSpeed.value)
  }
  watch(playbackSpeed, applyPlaybackSpeed)

  async function skipBack(): Promise<void> {
    if (!open.value) return
    await app.audioPlayer.seekBy(-SKIP_DELTA_MS)
    // Optimistic local update so the progress bar moves before the next
    // native tick lands; the tracker will correct on the next emit.
    positionMs.value = Math.max(0, positionMs.value - SKIP_DELTA_MS)
  }

  async function skipForward(): Promise<void> {
    if (!open.value) return
    await app.audioPlayer.seekBy(SKIP_DELTA_MS)
    const upper = durationMs.value > 0 ? durationMs.value : positionMs.value + SKIP_DELTA_MS
    positionMs.value = Math.min(upper, positionMs.value + SKIP_DELTA_MS)
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
    //
    // Disarm the progress guard FIRST so late events from the previous
    // track that arrive during `session.finishCurrent` cannot mutate
    // playing/positionMs/durationMs against stale state. The progress
    // callback above rejects everything while `itemId.value === null`.
    const prevItemId = itemId.value
    const prevPositionMs = positionMs.value
    itemId.value = null
    if (prevItemId) {
      await session.finishCurrent(prevItemId, prevPositionMs)
    }

    const duration = cmd.audio.duration ?? 0
    const resumeMs = await resumePosition.resolve(
      { itemId: args.itemId, resumeFromMs: args.resumeFromMs },
      duration
    )

    const localUrl = await useDownloadStore().ensureDownloaded(cmd.trackId, cmd.audio.path)
    const url = localUrl ?? app.storagePublicUrl.get(cmd.audio.path)

    // Continuous playback (Pro): hand the whole playlist tail to the native
    // engine so it can auto-advance on its own — including in the
    // background, where the JS layer is suspended. Off → single-track path.
    const wantQueue =
      autoPlayNext.value && usePurchasesStore().isSubscribed && args.itemId !== undefined

    subscribeOnce()
    try {
      let started = false
      if (wantQueue) {
        const queue = await usePlaylistStore().buildQueueFrom(cmd.itemId, args.preferredLanguage)
        const startIndex = queue.findIndex((q) => q.itemId === cmd.itemId)
        if (queue.length > 0 && startIndex >= 0) {
          // Use the just-ensured (downloaded) URL for the start item.
          queue[startIndex] = { ...queue[startIndex], url }
          currentQueue = queue
          queueActive = true
          await app.audioPlayer.setQueue(queue, startIndex, resumeMs)
          started = true
        }
      }
      if (!started) {
        currentQueue = []
        queueActive = false
        await app.audioPlayer.open({
          itemId: cmd.itemId,
          url,
          title: cmd.title,
          author: cmd.authorName,
        })
      }
      // Re-apply the user's mix and speed settings — a fresh native
      // MediaItem / AVPlayerItem loses both the processor binding and the
      // playback rate. (Native re-applies on each queue advance too.)
      applyMix()
      applyPlaybackSpeed()
      // The queue path starts playback at `resumeMs` itself; the
      // single-track path seeks + plays explicitly.
      if (!queueActive) {
        if (resumeMs > 0) await app.audioPlayer.seek(resumeMs)
        await app.audioPlayer.play()
      }
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
    // The engine emits playing=false → session.applyStatus closes the
    // session on the next tick. Patch the playlist immediately so the
    // UI doesn't have to wait for a render-cycle round-trip.
    if (itemId.value) patchPlaylistProgress(itemId.value, positionMs.value)
  }

  /** Idempotent pause — only ever pauses, never resumes. `togglePause`
   *  toggles, so guarding on `playing` here keeps a stray double-claim
   *  from flipping a paused lecture back into playback. Keeps the resume
   *  position (unlike inline snippets, which rewind to 0). */
  async function pause(): Promise<void> {
    if (!open.value || !playing.value) return
    await app.audioPlayer.togglePause()
    if (itemId.value) patchPlaylistProgress(itemId.value, positionMs.value)
  }

  // Register the lecture as the orchestrator's "main" audio source: it
  // pauses inline snippets when it starts AND gets paused when a snippet
  // starts (see useAudioOrchestrator). `playing` flips true on every
  // start — in-app tap, openTrack, and native lock-screen / headphone
  // resume, all arriving through the progress listener — so claiming on
  // the false→true edge covers them all. The edge guard keeps steady
  // ticks and the pause edge from re-firing.
  const mainAudioSource = registerAudioSource("main", () => {
    void pause()
  })
  watch(playing, (now, prev) => {
    if (now && !prev) mainAudioSource.claim()
  })
  onScopeDispose(() => {
    mainAudioSource.release()
  })

  async function seek(ms: number): Promise<void> {
    if (!open.value) return
    const safe = Number.isFinite(ms) ? ms : 0
    const upper = durationMs.value > 0 ? durationMs.value : safe
    const clamped = Math.max(0, Math.min(upper, safe))
    const before = positionMs.value
    positionMs.value = clamped
    await app.audioPlayer.seek(clamped)
    if (itemId.value) {
      await session.recordSeek({
        itemId: itemId.value,
        positionBeforeMs: before,
        positionAfterMs: clamped,
        willKeepPlaying: playing.value,
      })
    }
  }

  /** Skip to the next queued lecture (continuous-playback mode only). The
   *  engine advances natively; we then resync identity + journal. */
  async function playNext(): Promise<void> {
    if (!queueActive) return
    await app.audioPlayer.skipToNext()
    await syncFromNative()
  }

  /** Skip to the previous queued lecture (continuous-playback mode only). */
  async function playPrevious(): Promise<void> {
    if (!queueActive) return
    await app.audioPlayer.skipToPrevious()
    await syncFromNative()
  }

  async function stop(): Promise<void> {
    if (!open.value) return
    const id = itemId.value
    if (id) {
      // finishCurrent closes the open session if any AND patches the
      // playlist unconditionally — matches the prior stop() semantics
      // where the playlist always saw the final position even if no
      // session had been opened (paused-then-stopped).
      await session.finishCurrent(id, positionMs.value)
    }
    await app.audioPlayer.stop()
    trackId.value = null
    itemId.value = null
    playing.value = false
    positionMs.value = 0
    durationMs.value = 0
    queueActive = false
    currentQueue = []
  }

  function flushProgressNow(): void {
    session.flushOnHide()
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
    mixPosition,
    playbackSpeed,
    open,
    openTrack,
    togglePause,
    pause,
    seek,
    skipBack,
    skipForward,
    playNext,
    playPrevious,
    stop,
    flushProgressNow,
  }
})

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
