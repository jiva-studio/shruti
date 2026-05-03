import type { PlaylistItemId } from "@lib/domain/core.js"
import type { ListeningSessionId } from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"

/** Persist a tick at most once per N ms while playing. */
const TICK_INTERVAL_MS = 15_000

export interface ListeningSessionTrackerDeps {
  /** Lazy resolver — repos may not be ready when the tracker is created. */
  getRepo: () => IListeningSessionRepository
}

export interface ListeningSessionTracker {
  start(args: { itemId: PlaylistItemId; positionMs: number }): Promise<void>
  forceStart(args: { itemId: PlaylistItemId; positionMs: number }): Promise<void>
  tick(args: { positionMs: number }): Promise<void>
  finish(args: { positionMs: number }): Promise<void>
  /**
   * Close the current session at `positionBeforeMs` and, if the player
   * will keep playing, immediately open a new one starting at
   * `positionAfterMs`. Used by the player's `seek()` — a seek is an
   * explicit discontinuity, not continued listening.
   */
  seek(args: {
    itemId: PlaylistItemId
    positionBeforeMs: number
    positionAfterMs: number
    willKeepPlaying: boolean
  }): Promise<void>
  /** Close the current session right now; safe to call when no session is open. */
  flushOnHide(args: { positionMs: number }): Promise<void>
  hasActiveSession(): boolean
  activeItemId(): PlaylistItemId | null
}

function msToSec(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / 1000)
}

/**
 * Stateful wrapper around `IListeningSessionRepository` that keeps an
 * in-memory pointer to the currently-open session id. The player calls
 * `start` on play, `tick` while playing (throttled), `finish` on
 * pause/track-change/visibility-hide, and `seek` on user seeks.
 *
 * Position is in milliseconds in the player; we convert to seconds at
 * this boundary so the journal stores compact integers.
 */
export function useListeningSessionTracker(
  deps: ListeningSessionTrackerDeps
): ListeningSessionTracker {
  let activeSessionId: ListeningSessionId | null = null
  let activeItemId: PlaylistItemId | null = null
  let lastTickAt = 0

  async function start({ itemId, positionMs }: { itemId: PlaylistItemId; positionMs: number }) {
    if (activeSessionId !== null) {
      // Defensive: caller forgot to close. Close at the previous tick's
      // recorded position and open a new one. We don't have the previous
      // position here, so close at the same position (effectively a noop).
      try {
        await deps.getRepo().finish(activeSessionId, { position: msToSec(positionMs) })
      } catch {
        // ignore — we'll still open a new session below
      }
    }
    activeSessionId = await deps.getRepo().start({ itemId, position: msToSec(positionMs) })
    activeItemId = itemId
    lastTickAt = Date.now()
  }

  async function forceStart({
    itemId,
    positionMs,
  }: {
    itemId: PlaylistItemId
    positionMs: number
  }) {
    activeSessionId = await deps.getRepo().forceStart({ itemId, position: msToSec(positionMs) })
    activeItemId = itemId
    lastTickAt = Date.now()
  }

  async function tick({ positionMs }: { positionMs: number }) {
    if (activeSessionId === null) return
    const now = Date.now()
    if (now - lastTickAt < TICK_INTERVAL_MS) return
    lastTickAt = now
    await deps.getRepo().tick(activeSessionId, { position: msToSec(positionMs) })
  }

  async function finish({ positionMs }: { positionMs: number }) {
    if (activeSessionId === null) return
    const id = activeSessionId
    activeSessionId = null
    activeItemId = null
    await deps.getRepo().finish(id, { position: msToSec(positionMs) })
  }

  async function seek({
    itemId,
    positionBeforeMs,
    positionAfterMs,
    willKeepPlaying,
  }: {
    itemId: PlaylistItemId
    positionBeforeMs: number
    positionAfterMs: number
    willKeepPlaying: boolean
  }) {
    if (activeSessionId !== null) {
      const id = activeSessionId
      activeSessionId = null
      activeItemId = null
      await deps.getRepo().finish(id, { position: msToSec(positionBeforeMs) })
    }
    if (willKeepPlaying) {
      await forceStart({ itemId, positionMs: positionAfterMs })
    }
  }

  async function flushOnHide({ positionMs }: { positionMs: number }) {
    await finish({ positionMs })
  }

  return {
    start,
    forceStart,
    tick,
    finish,
    seek,
    flushOnHide,
    hasActiveSession: () => activeSessionId !== null,
    activeItemId: () => activeItemId,
  }
}
