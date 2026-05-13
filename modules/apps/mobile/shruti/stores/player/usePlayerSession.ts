import type { Ref } from "vue"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { useShruti } from "@shruti/shruti.js"
import { useListeningSessionTracker } from "@shruti/composables/useListeningSessionTracker.js"
import { isCompleted } from "@lib/domain/listeningSession.js"

export interface PlayerSessionDeps {
  readonly itemIdRef: Ref<PlaylistItemId | null>
  readonly playingRef: Ref<boolean>
  readonly positionMsRef: Ref<number>
  /** Notify the playlist UI of the latest position so it doesn't have
   *  to wait on a render-cycle round-trip. */
  readonly patchPlaylistProgress: (id: PlaylistItemId, ms: number) => void
}

export interface PlayerSessionReturn {
  /** Drive the session lifecycle from a native progress event. */
  applyStatus(position: number, duration: number): void
  /** Best-effort flush before backgrounding/closing. */
  flushOnHide(): void
  /**
   * Close the previous track's session (if any) and patch the playlist
   * unconditionally, so the playlist UI reflects the final position
   * even when no session was open (e.g. `stop()` after a paused-but-
   * never-played open).
   */
  finishCurrent(itemId: PlaylistItemId, positionMs: number): Promise<void>
  /**
   * Mirror an in-engine seek to the journal — close the open session at
   * the previous position and, if the player will keep playing, open a
   * new one starting at the new position. The seek is a discontinuity,
   * not continued listening.
   */
  recordSeek(args: {
    itemId: PlaylistItemId
    positionBeforeMs: number
    positionAfterMs: number
    willKeepPlaying: boolean
  }): Promise<void>
  hasActive(): boolean
  activeItemId(): PlaylistItemId | null
}

/**
 * Encapsulates the player's interaction with `listening_sessions`. The
 * tracker opens a session on play, ticks while playing, and closes on
 * pause / track-change / visibility-hide; this composable wires those
 * calls to the player's reactive state and to the playlist's patch
 * callback so the UI stays in sync without a full refresh.
 */
export function usePlayerSession(deps: PlayerSessionDeps): PlayerSessionReturn {
  const app = useShruti()
  const tracker = useListeningSessionTracker({
    getRepo: () => app.repositories().listeningSessions,
  })

  function applyStatus(position: number, duration: number): void {
    const id = deps.itemIdRef.value
    if (!id) return

    const reachedEnd = isCompleted(position, duration)

    if (reachedEnd) {
      if (tracker.hasActiveSession()) {
        void tracker
          .finish({ positionMs: duration })
          .then(() => deps.patchPlaylistProgress(id, duration))
      } else {
        deps.patchPlaylistProgress(id, duration)
      }
      return
    }

    if (deps.playingRef.value) {
      if (!tracker.hasActiveSession() || tracker.activeItemId() !== id) {
        void tracker.start({ itemId: id, positionMs: position })
      } else {
        void tracker.tick({ positionMs: position })
      }
    } else if (tracker.hasActiveSession()) {
      void tracker
        .finish({ positionMs: position })
        .then(() => deps.patchPlaylistProgress(id, position))
    }
  }

  function flushOnHide(): void {
    const id = deps.itemIdRef.value
    if (!id) return
    if (tracker.hasActiveSession()) {
      const pos = deps.positionMsRef.value
      void tracker.flushOnHide({ positionMs: pos }).then(() => deps.patchPlaylistProgress(id, pos))
    }
  }

  async function finishCurrent(itemId: PlaylistItemId, positionMs: number): Promise<void> {
    if (tracker.hasActiveSession()) {
      await tracker.finish({ positionMs })
    }
    deps.patchPlaylistProgress(itemId, positionMs)
  }

  async function recordSeek(args: {
    itemId: PlaylistItemId
    positionBeforeMs: number
    positionAfterMs: number
    willKeepPlaying: boolean
  }): Promise<void> {
    await tracker.seek(args)
    deps.patchPlaylistProgress(args.itemId, args.positionAfterMs)
  }

  return {
    applyStatus,
    flushOnHide,
    finishCurrent,
    recordSeek,
    hasActive: tracker.hasActiveSession,
    activeItemId: tracker.activeItemId,
  }
}
