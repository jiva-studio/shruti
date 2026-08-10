import {
  AudioPlayer,
  type PositionJump,
  type QueueTransition,
  type Status,
} from "@lectorium/plugin-audio-player"
import type {
  AudioMixParams,
  AudioOpenParams,
  AudioPositionJumpListener,
  AudioProgressListener,
  AudioQueueItem,
  AudioQueueState,
  AudioTransitionListener,
  IAudioPlayer,
} from "@ports/app/audioPlayer.js"

/**
 * Adapter over the @lectorium/plugin-audio-player Capacitor plugin (native +
 * web fallback).
 *
 * The plugin's surface (Android/iOS/web fallback) speaks **seconds** for
 * positions and durations — same convention as HTMLMediaElement. Our
 * `IAudioPlayer` contract speaks **milliseconds**. This adapter is the
 * single boundary where the conversion happens, so the rest of the app
 * stays in one consistent unit.
 *
 * onProgressChanged in the plugin is a fire-and-forget subscription —
 * there is no off() on the returned id, so we multiplex listeners in
 * this adapter and register the plugin callback only once.
 */
export function useCapacitorAudioPlayer(): IAudioPlayer {
  const listeners = new Set<AudioProgressListener>()
  const transitionListeners = new Set<AudioTransitionListener>()
  const jumpListeners = new Set<AudioPositionJumpListener>()
  let registered = false
  let transitionRegistered = false
  let jumpRegistered = false

  async function ensureRegistered(): Promise<void> {
    if (registered) return
    registered = true
    await AudioPlayer.onProgressChanged((status: Status) => {
      for (const fn of listeners) {
        fn({
          itemId: status.itemId,
          playing: status.playing,
          position: Math.round(status.position * 1000),
          duration: Math.round(status.duration * 1000),
        })
      }
    })
  }

  async function ensureJumpRegistered(): Promise<void> {
    if (jumpRegistered) return
    jumpRegistered = true
    await AudioPlayer.onPositionJump((jump: PositionJump) => {
      const mapped = {
        itemId: jump.itemId,
        fromMs: Math.round(jump.fromPosition * 1000),
        toMs: Math.round(jump.toPosition * 1000),
      }
      for (const fn of jumpListeners) fn(mapped)
    })
  }

  async function ensureTransitionRegistered(): Promise<void> {
    if (transitionRegistered) return
    transitionRegistered = true
    await AudioPlayer.onItemTransition((t: QueueTransition) => {
      const mapped = toMsTransition(t)
      for (const fn of transitionListeners) fn(mapped)
    })
  }

  return {
    async open(params: AudioOpenParams): Promise<void> {
      await ensureRegistered()
      await AudioPlayer.open({
        itemId: params.itemId,
        url: params.url,
        title: params.title,
        author: params.author,
        cover: params.cover,
      })
    },
    async play(): Promise<void> {
      await AudioPlayer.play()
    },
    async togglePause(): Promise<void> {
      await AudioPlayer.togglePause()
    },
    async seek(positionMs: number): Promise<void> {
      await AudioPlayer.seek({ position: positionMs / 1000 }).catch(ignoreSupersededSeek)
    },
    async stop(): Promise<void> {
      await AudioPlayer.stop()
    },
    async seekBy(deltaMs: number): Promise<void> {
      const safe = Number.isFinite(deltaMs) ? deltaMs : 0
      // Plugin surface speaks seconds (same as `seek`). The IAudioPlayer
      // contract is in milliseconds; this is the boundary that converts.
      await AudioPlayer.seekBy({ delta: safe / 1000 }).catch(ignoreSupersededSeek)
    },
    async setMix(params: AudioMixParams): Promise<void> {
      const ratio = clamp01(params.ratio)
      await AudioPlayer.setMix({ enabled: params.enabled, ratio })
    },
    async setPlaybackRate(rate: number): Promise<void> {
      let safe = Number.isFinite(rate) ? rate : 1
      if (safe < 0.5) safe = 0.5
      if (safe > 2) safe = 2
      await AudioPlayer.setPlaybackRate({ rate: safe })
    },
    async setProgressInterval(intervalMs: number): Promise<void> {
      const safe = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.round(intervalMs) : 1000
      await AudioPlayer.setProgressInterval({ intervalMs: safe })
    },
    onProgress(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onPositionJump(listener): () => void {
      jumpListeners.add(listener)
      void ensureJumpRegistered()
      return () => jumpListeners.delete(listener)
    },
    async setQueue(
      items: AudioQueueItem[],
      startIndex: number,
      startPositionMs: number
    ): Promise<void> {
      await ensureRegistered()
      await AudioPlayer.setQueue({
        items: items.map(toPluginQueueItem),
        startIndex,
        startPosition: startPositionMs / 1000,
      })
    },
    async appendToQueue(items: AudioQueueItem[]): Promise<void> {
      await AudioPlayer.appendToQueue({ items: items.map(toPluginQueueItem) })
    },
    async getQueueState(): Promise<AudioQueueState> {
      const s = await AudioPlayer.getQueueState()
      return {
        currentItemId: s.currentItemId,
        positionMs: Math.round(s.position * 1000),
        durationMs: Math.round(s.duration * 1000),
        playing: s.playing,
        events: s.events.map(toMsTransition),
      }
    },
    async ackEvents(upToSeq: number): Promise<void> {
      await AudioPlayer.ackEvents({ upToSeq })
    },
    async skipToNext(): Promise<void> {
      await AudioPlayer.skipToNext()
    },
    async skipToPrevious(): Promise<void> {
      await AudioPlayer.skipToPrevious()
    },
    onTransition(listener): () => void {
      transitionListeners.add(listener)
      void ensureTransitionRegistered()
      return () => transitionListeners.delete(listener)
    },
  }
}

function toPluginQueueItem(item: AudioQueueItem): {
  itemId: string
  url: string
  title: string
  author: string
  cover?: string
  duration?: number
} {
  return {
    itemId: item.itemId,
    url: item.url,
    title: item.title,
    author: item.author,
    cover: item.cover,
    duration: item.durationMs !== undefined ? item.durationMs / 1000 : undefined,
  }
}

function toMsTransition(t: QueueTransition) {
  return {
    finishedItemId: t.finishedItemId,
    fromPositionMs: Math.round(t.fromPosition * 1000),
    finishedAtMs: Math.round(t.finishedAt * 1000),
    durationMs: Math.round(t.duration * 1000),
    startedItemId: t.startedItemId,
    reason: t.reason,
    at: t.at,
    seq: t.seq,
  }
}

// A seek can be superseded by a newer seek or an item replacement before its
// native AVPlayer completion fires (finished:false → the plugin rejects with
// "Seek operation failed"). That case is benign — callers set position
// optimistically and the native progress tick reconciles — so swallow ONLY it,
// avoiding a leaked unhandledrejection (LETORIUM-8). A genuinely different seek
// fault (bad args, plugin unavailable) still throws so it stays visible and the
// awaiting caller (e.g. openTrack's resume) can react.
function ignoreSupersededSeek(e: unknown): void {
  const msg = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)
  if (!/Seek operation failed/i.test(msg)) throw e
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
