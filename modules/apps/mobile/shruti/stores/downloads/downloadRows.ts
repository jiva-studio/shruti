import { ref, type Ref } from "vue"
import type { TrackId } from "@lib/domain/core.js"

/**
 * What a track's row shows.
 *
 * `pending` is a tap acknowledged before anything about it is known; it is
 * a claim over whatever the row held, and releasing the claim puts that state
 * back. `deferred` is queued for offline use but held back because the storage
 * budget is spent — neither a failure nor in flight.
 */
export type DownloadState = "idle" | "pending" | "downloading" | "deferred" | "completed" | "failed"

export interface DownloadRows {
  readonly states: Ref<Map<TrackId, DownloadState>>
  readonly progress: Ref<Map<TrackId, number>>
  setState(trackId: TrackId, state: DownloadState): void
  /** Drop a track back to "idle": no state, no progress, no red X. */
  clearState(trackId: TrackId): void
  setProgress(trackId: TrackId, pct: number): void
  getState(trackId: TrackId): DownloadState
  getProgress(trackId: TrackId): number
  /**
   * What a row really is underneath a `pending` claim. Callers that must not
   * overwrite a terminal state have to read this, not the raw map — a claimed
   * row reads "pending" while still being a failed one.
   */
  effectiveState(trackId: TrackId): DownloadState | undefined
  getEffectiveState(trackId: TrackId): DownloadState
  markPending(trackId: TrackId): void
  clearPending(trackId: TrackId): void
  markDeferred(trackId: TrackId): void
  markStartingDownload(trackId: TrackId): void
  /** The generation the rows are in; a wipe bumps it. */
  currentEpoch(): number
  bumpEpoch(): void
  clear(): void
}

export function createDownloadRows(): DownloadRows {
  const states = ref<Map<TrackId, DownloadState>>(new Map())
  const progress = ref<Map<TrackId, number>>(new Map())
  // Live `pending` claims: how many callers wait on this row, and the state the
  // first of them replaced. Kept out of `states` so releasing a claim can
  // restore the row instead of blanking it.
  const pendingClaims = new Map<TrackId, { count: number; previous: DownloadState | undefined }>()
  let epoch = 0

  function setState(trackId: TrackId, state: DownloadState): void {
    const next = new Map(states.value)
    next.set(trackId, state)
    states.value = next
    if (state !== "downloading") {
      const p = new Map(progress.value)
      if (p.delete(trackId)) progress.value = p
    }
  }

  function clearState(trackId: TrackId): void {
    const nextStates = new Map(states.value)
    nextStates.delete(trackId)
    states.value = nextStates
    const nextProgress = new Map(progress.value)
    if (nextProgress.delete(trackId)) progress.value = nextProgress
  }

  function setProgress(trackId: TrackId, pct: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)))
    if (progress.value.get(trackId) === clamped) return
    const next = new Map(progress.value)
    next.set(trackId, clamped)
    progress.value = next
  }

  function effectiveState(trackId: TrackId): DownloadState | undefined {
    const current = states.value.get(trackId)
    if (current !== "pending") return current
    return pendingClaims.get(trackId)?.previous
  }

  /**
   * Paint a track as "waiting for space" without touching a terminal state.
   *
   * Deliberately NOT guarded on whether a transfer is running: the running
   * attempt calls this on itself when the budget gate refuses it.
   */
  function markDeferred(trackId: TrackId): void {
    const current = effectiveState(trackId)
    if (current === "completed" || current === "failed") return
    setState(trackId, "deferred")
  }

  /**
   * Synchronously acknowledge a tap before anything is known about it —
   * including a tap on a failed row, whose retry has just as far to travel
   * before it paints anything. Claims nest: two opens racing the same row each
   * hold one, and the row stays claimed until the last of them lets go.
   */
  function markPending(trackId: TrackId): void {
    const claim = pendingClaims.get(trackId)
    if (claim) {
      claim.count += 1
      return
    }
    const current = states.value.get(trackId)
    if (current === "completed" || current === "downloading" || current === "pending") return
    pendingClaims.set(trackId, { count: 1, previous: current })
    setState(trackId, "pending")
  }

  /**
   * Release a `pending` claim. The last one out restores whatever the claim
   * replaced. Balanced against `markPending`, so it is safe to call
   * unconditionally from a `finally`.
   */
  function clearPending(trackId: TrackId): void {
    const claim = pendingClaims.get(trackId)
    if (!claim) return
    claim.count -= 1
    if (claim.count > 0) return
    pendingClaims.delete(trackId)
    // Restore only a row still showing OUR claim. A real outcome wins, and so
    // does an entry a canceller DELETED — that is what stops a release putting
    // the red X back on a row the user just asked us to drop, so a canceller
    // must delete the entry rather than write "idle" over it.
    if (states.value.get(trackId) !== "pending") return
    if (claim.previous === undefined) {
      const next = new Map(states.value)
      next.delete(trackId)
      states.value = next
      return
    }
    setState(trackId, claim.previous)
  }

  /**
   * Claim "downloading" up front, so a row paints as downloading instead of
   * flashing the "added" checkmark while the audio path resolves.
   *
   * A terminal state is preserved: "completed" must not visually rewind, and
   * "failed" must survive so the next attempt takes the retry path.
   */
  function markStartingDownload(trackId: TrackId): void {
    const current = effectiveState(trackId)
    if (current === "completed" || current === "failed") return
    setProgress(trackId, 0)
    setState(trackId, "downloading")
  }

  function clear(): void {
    pendingClaims.clear()
    states.value = new Map()
    progress.value = new Map()
  }

  return {
    states,
    progress,
    setState,
    clearState,
    setProgress,
    getState: (trackId) => states.value.get(trackId) ?? "idle",
    getProgress: (trackId) => progress.value.get(trackId) ?? 0,
    effectiveState,
    getEffectiveState: (trackId) => effectiveState(trackId) ?? "idle",
    markPending,
    clearPending,
    markDeferred,
    markStartingDownload,
    currentEpoch: () => epoch,
    bumpEpoch: () => {
      epoch += 1
    },
    clear,
  }
}
