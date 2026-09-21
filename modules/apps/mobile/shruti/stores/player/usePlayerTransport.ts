import { useShruti } from "@shruti/shruti.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import type { PlayerIdentityRefs } from "./playerIdentity.js"
import type { PlayerQueueMirrorReturn } from "./usePlayerQueueMirror.js"
import type { PlayerSessionReturn } from "./usePlayerSession.js"

const SKIP_DELTA_MS = 15000

export interface PlayerTransportDeps {
  readonly refs: PlayerIdentityRefs
  readonly queue: PlayerQueueMirrorReturn
  readonly session: PlayerSessionReturn
  readonly syncFromNative: () => Promise<void>
  /** Tell the playlist UI the latest position without a render round-trip. */
  readonly patchPlaylistProgress: (id: PlaylistItemId, ms: number) => void
}

export interface PlayerTransportReturn {
  /**
   * Journal a position discontinuity: close the open session where playback
   * actually left off and reopen at the landing point. Without it the next
   * tick raises `to_position` over the skipped span and the day's total counts
   * audio nobody heard.
   */
  journalJump(beforeMs: number, afterMs: number): Promise<void>
  seek(ms: number): Promise<void>
  skipBack(): Promise<void>
  skipForward(): Promise<void>
  togglePause(): Promise<void>
  /** Idempotent pause — never resumes, unlike `togglePause`, so a stray
   *  double-claim can't flip a paused lecture back into playback. Keeps the
   *  resume position. */
  pause(): Promise<void>
  /** Skip to the next queued lecture (continuous playback only). The engine
   *  advances natively; we then resync identity + journal. */
  playNext(): Promise<void>
  playPrevious(): Promise<void>
  stop(): Promise<void>
}

/** The player's commands to the engine, and the journal writes they owe. */
export function usePlayerTransport(deps: PlayerTransportDeps): PlayerTransportReturn {
  const app = useShruti()
  const { refs, queue, session } = deps

  function isOpen(): boolean {
    return refs.trackId.value !== null
  }

  async function journalJump(beforeMs: number, afterMs: number): Promise<void> {
    const id = refs.itemId.value
    if (!id || beforeMs === afterMs) return
    await session.recordSeek({
      itemId: id,
      positionBeforeMs: beforeMs,
      positionAfterMs: afterMs,
      willKeepPlaying: refs.playing.value,
    })
  }

  async function seek(ms: number): Promise<void> {
    if (!isOpen()) return
    const safe = Number.isFinite(ms) ? ms : 0
    const upper = refs.durationMs.value > 0 ? refs.durationMs.value : safe
    const clamped = Math.max(0, Math.min(upper, safe))
    const before = refs.positionMs.value
    refs.positionMs.value = clamped
    await app.audioPlayer.seek(clamped)
    await journalJump(before, clamped)
  }

  async function skipBack(): Promise<void> {
    if (!isOpen()) return
    const before = refs.positionMs.value
    await app.audioPlayer.seekBy(-SKIP_DELTA_MS)
    // Optimistic local update so the progress bar moves before the next native
    // tick lands; the tracker corrects it on the next emit.
    refs.positionMs.value = Math.max(0, before - SKIP_DELTA_MS)
    await journalJump(before, refs.positionMs.value)
  }

  async function skipForward(): Promise<void> {
    if (!isOpen()) return
    const before = refs.positionMs.value
    await app.audioPlayer.seekBy(SKIP_DELTA_MS)
    const upper = refs.durationMs.value > 0 ? refs.durationMs.value : before + SKIP_DELTA_MS
    refs.positionMs.value = Math.min(upper, before + SKIP_DELTA_MS)
    await journalJump(before, refs.positionMs.value)
  }

  async function togglePause(): Promise<void> {
    if (!isOpen()) return
    // A queue rewrite deferred while paused: resuming is exactly when to push
    // it, since `setQueue` starts playback itself. When the mirror can't place
    // the current item there is nothing to push — resume normally rather than
    // swallowing the tap.
    const pushed = queue.needsRewrite() && !refs.playing.value ? await queue.push() : false
    if (!pushed) await app.audioPlayer.togglePause()
    // The engine closes the session on its next tick; patch the playlist now so
    // the UI doesn't wait for a render-cycle round-trip.
    if (refs.itemId.value) deps.patchPlaylistProgress(refs.itemId.value, refs.positionMs.value)
  }

  async function pause(): Promise<void> {
    if (!isOpen() || !refs.playing.value) return
    await app.audioPlayer.togglePause()
    if (refs.itemId.value) deps.patchPlaylistProgress(refs.itemId.value, refs.positionMs.value)
  }

  async function playNext(): Promise<void> {
    if (!queue.isActive()) return
    await app.audioPlayer.skipToNext()
    await deps.syncFromNative()
  }

  async function playPrevious(): Promise<void> {
    if (!queue.isActive()) return
    await app.audioPlayer.skipToPrevious()
    await deps.syncFromNative()
  }

  async function stop(): Promise<void> {
    if (!isOpen()) return
    const id = refs.itemId.value
    // Closes the open session if any AND patches the playlist unconditionally,
    // so the final position lands even for a paused-then-stopped lecture.
    if (id) await session.finishCurrent(id, refs.positionMs.value)
    await app.audioPlayer.stop()
    refs.trackId.value = null
    refs.itemId.value = null
    refs.playing.value = false
    refs.positionMs.value = 0
    refs.durationMs.value = 0
    queue.clear()
    queue.markEngineReplaced()
    await queue.flushEvictions(true)
  }

  return {
    journalJump,
    seek,
    skipBack,
    skipForward,
    togglePause,
    pause,
    playNext,
    playPrevious,
    stop,
  }
}
