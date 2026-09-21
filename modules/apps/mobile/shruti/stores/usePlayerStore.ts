import { defineStore } from "pinia"
import { computed, onScopeDispose, ref, watch } from "vue"
import { App, type AppState } from "@capacitor/app"
import type { LanguageCode, PlaylistItemId, TrackId } from "@lib/domain/core.js"
import { useShruti } from "@shruti/shruti.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"
import { setNativeQueueRelease } from "@shruti/services/nativeQueue.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useAutoPlayNext } from "@shruti/composables/useAutoPlayNext.js"
import { registerAudioSource } from "@lib/chat/audio/useAudioOrchestrator.js"
import type { PlayerIdentityRefs } from "./player/playerIdentity.js"
import { usePlayerEngineEvents } from "./player/usePlayerEngineEvents.js"
import { usePlayerNativeSync } from "./player/usePlayerNativeSync.js"
import { usePlayerOpenTrack } from "./player/usePlayerOpenTrack.js"
import { usePlayerQueueMirror } from "./player/usePlayerQueueMirror.js"
import { usePlayerSession } from "./player/usePlayerSession.js"
import { usePlayerTransport } from "./player/usePlayerTransport.js"

export type { OpenArgs } from "./player/usePlayerOpenTrack.js"

/**
 * Ambient player state. A singleton because there's only ever one audio engine
 * at a time. Views call `openTrack(...)`; the floating player reads
 * `title/author/positionMs/durationMs/playing` reactively.
 *
 * The store owns the reactive identity and the audio settings, and wires up
 * the parts that live beside it under `stores/player/`: listening time in
 * `usePlayerSession`, the native queue and its eviction debt in
 * `usePlayerQueueMirror`, the drain of the native journal in
 * `usePlayerNativeSync`, engine events in `usePlayerEngineEvents`, the open
 * sequence in `usePlayerOpenTrack` and the commands in `usePlayerTransport`.
 */
export const usePlayerStore = defineStore("player", () => {
  const app = useShruti()
  const autoPlayNext = useAutoPlayNext()

  const trackId = ref<TrackId | null>(null)
  const title = ref<string>("")
  const authorName = ref<string>("")
  const language = ref<LanguageCode | null>(null)
  const playing = ref<boolean>(false)
  const positionMs = ref<number>(0)
  const durationMs = ref<number>(0)
  const itemId = ref<PlaylistItemId | null>(null)
  const refs: PlayerIdentityRefs = {
    trackId,
    title,
    authorName,
    language,
    playing,
    positionMs,
    durationMs,
    itemId,
  }

  /**
   * Stereo-mix slider position, persisted globally so the user's choice
   * survives restarts and follows them across tracks.
   *
   *   −1 — both ears hear the original (left channel) only
   *    0 — mix OFF: native stereo (different content per ear)
   *   +1 — both ears hear the translation (right channel) only
   */
  const mixPosition = useConfig<number>("settings.audio.mixPosition", 0)
  const mixEnabled = computed(() => mixPosition.value !== 0)
  const mixRatio = computed(() => clamp01((mixPosition.value + 1) / 2))

  /** Playback speed (1.0 = normal); engines preserve pitch. Persisted. */
  const playbackSpeed = useConfig<number>("settings.audio.playbackSpeed", 1.0)

  const open = computed(() => trackId.value !== null)

  function patchPlaylistProgress(id: PlaylistItemId, ms: number): void {
    // Pass the engine-reported duration so completion is marked for items that
    // live past the playlist's first paged window too.
    void usePlaylistStore().patchProgress(id, ms, durationMs.value)
  }

  /** Push the current slider state to the engine. A fresh native MediaItem /
   *  AVPlayerItem loses the processor / tap binding. */
  function applyMix(): void {
    void app.audioPlayer.setMix({ enabled: mixEnabled.value, ratio: mixRatio.value })
  }
  watch(mixPosition, applyMix)

  /** Push playback speed to the engine. Same re-apply contract as the mix:
   *  native items lose the rate on every open, and on iOS pause→play too. */
  function applyPlaybackSpeed(): void {
    void app.audioPlayer.setPlaybackRate(playbackSpeed.value)
  }
  watch(playbackSpeed, applyPlaybackSpeed)

  function applyEngineSettings(): void {
    applyMix()
    applyPlaybackSpeed()
  }

  const session = usePlayerSession({
    itemIdRef: itemId,
    playingRef: playing,
    positionMsRef: positionMs,
    patchPlaylistProgress,
  })
  const queue = usePlayerQueueMirror({ refs, autoPlayNext })
  const { syncFromNative } = usePlayerNativeSync({ refs, queue, session, applyEngineSettings })
  const transport = usePlayerTransport({
    refs,
    queue,
    session,
    syncFromNative,
    patchPlaylistProgress,
  })
  const events = usePlayerEngineEvents({
    refs,
    session,
    syncFromNative,
    journalJump: transport.journalJump,
  })
  const { openTrack } = usePlayerOpenTrack({
    refs,
    queue,
    session,
    autoPlayNext,
    subscribeOnce: events.subscribeOnce,
    applyEngineSettings,
    seek: transport.seek,
  })
  setNativeQueueRelease(queue.dropFromQueue)

  // Drain on every foreground resume (the background queue may have advanced
  // or finished while JS was suspended) and once at startup.
  let appStateHandle: { remove: () => void } | null = null
  void App.addListener("appStateChange", (state: AppState) => {
    if (state.isActive) void syncFromNative()
  }).then((h) => {
    appStateHandle = h
  })
  // Armed up front so a queue restored from a killed session is followed in
  // the foreground too, not only across the next background cycle.
  events.subscribeOnce()
  void syncFromNative()

  const purchases = usePurchasesStore()
  watch(
    () => purchases.isSubscribed,
    (now, was) => {
      // The entitlement can land after a cold-start open: re-arm the queue
      // rather than delay the first play until RevenueCat has answered.
      if (!now || was) return
      void queue.armForEntitlement().catch((e: unknown) => reportError("player", e))
    }
  )

  // The lecture is the orchestrator's "main" audio source: it pauses inline
  // snippets when it starts and is paused when a snippet starts. `playing`
  // flips true on every start — in-app tap, open, lock-screen resume — so the
  // false→true edge covers them all without re-firing on steady ticks.
  const mainAudioSource = registerAudioSource("main", () => {
    void transport.pause()
  })
  watch(playing, (now, prev) => {
    if (now && !prev) mainAudioSource.claim()
  })

  onScopeDispose(() => {
    events.unsubscribe()
    appStateHandle?.remove()
    appStateHandle = null
    setNativeQueueRelease(null)
    mainAudioSource.release()
  })

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
    togglePause: transport.togglePause,
    pause: transport.pause,
    seek: transport.seek,
    skipBack: transport.skipBack,
    skipForward: transport.skipForward,
    playNext: transport.playNext,
    playPrevious: transport.playPrevious,
    stop: transport.stop,
    flushProgressNow,
  }
})

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
