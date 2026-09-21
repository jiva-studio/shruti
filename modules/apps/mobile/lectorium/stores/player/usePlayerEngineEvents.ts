import { useLectorium } from "@lectorium/lectorium.js"
import { reportError } from "@lectorium/services/monitoring/reportError.js"
import type { PlayerIdentityRefs } from "./playerIdentity.js"
import type { PlayerSessionReturn } from "./usePlayerSession.js"

export interface PlayerEngineEventsDeps {
  readonly refs: PlayerIdentityRefs
  readonly session: PlayerSessionReturn
  /** Re-derive everything from the engine — it moved without us. */
  readonly syncFromNative: () => Promise<void>
  /** Journal a position discontinuity the engine made on its own. */
  readonly journalJump: (beforeMs: number, afterMs: number) => Promise<void>
}

export interface PlayerEngineEventsReturn {
  /** Idempotent — callers arm it at startup and again on every open. */
  subscribeOnce(): void
  unsubscribe(): void
}

/** Mirrors the native engine's progress, transition and jump events into the
 *  player's reactive state. */
export function usePlayerEngineEvents(deps: PlayerEngineEventsDeps): PlayerEngineEventsReturn {
  const app = useLectorium()
  const { refs, session } = deps

  let unsubscribeProgress: (() => void) | null = null
  let unsubscribeTransition: (() => void) | null = null
  let unsubscribeJump: (() => void) | null = null

  function subscribeOnce(): void {
    if (unsubscribeProgress) return
    // Jumps the engine made without us — lock-screen scrubbing, the system
    // ±15s commands, a Bluetooth remote. JS never issued them, so nothing has
    // journaled the discontinuity and the next progress tick would silently
    // extend the open session across the skipped span.
    unsubscribeJump = app.audioPlayer.onPositionJump((jump) => {
      if (refs.itemId.value === null || jump.itemId !== refs.itemId.value) return
      refs.positionMs.value = jump.toMs
      void deps.journalJump(jump.fromMs, jump.toMs).catch((e: unknown) => reportError("player", e))
    })
    // Native pushes a transition the instant the queue advances — react to it
    // rather than waiting on the next (1–5s, adaptive) progress tick. The
    // durable journal drained via `getQueueState` is still the source of truth.
    unsubscribeTransition = app.audioPlayer.onTransition(() => {
      void deps.syncFromNative()
    })
    unsubscribeProgress = app.audioPlayer.onProgress((status) => {
      // No track loaded (mid-swap or pre-open). The swap path nulls `itemId`
      // BEFORE awaiting the session finish, so this rejects in-flight events.
      if (refs.itemId.value === null) return
      if (status.itemId !== refs.itemId.value) {
        // A different item is playing than the one we think is current — the
        // engine auto-advanced. NOT gated on queue mode: after a cold restart
        // the queue is live but `loadTrack` never ran, so the gate would drop
        // every foreground advance. The sync no-ops when there is nothing to
        // mirror, so single-track playback is safe here too.
        void deps.syncFromNative()
        return
      }
      refs.playing.value = status.playing
      refs.positionMs.value = status.position
      if (status.duration > 0) refs.durationMs.value = status.duration
      session.applyStatus(status.position, status.duration)
    })
  }

  function unsubscribe(): void {
    unsubscribeProgress?.()
    unsubscribeProgress = null
    unsubscribeTransition?.()
    unsubscribeTransition = null
    unsubscribeJump?.()
    unsubscribeJump = null
  }

  return { subscribeOnce, unsubscribe }
}
