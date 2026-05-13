import { getProgressForItem } from "@lib/application/getProgressForItem.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { isCompleted } from "@lib/domain/listeningSession.js"
import { useLectorium } from "@lectorium/lectorium.js"

export interface ResumePositionInput {
  readonly itemId?: PlaylistItemId
  /** Resume position in milliseconds, or `null` to start from 0
   *  regardless of saved progress. `undefined` means "look it up". */
  readonly resumeFromMs?: number | null
}

export interface PlayerResumePositionReturn {
  /**
   * Resolve the millisecond position the audio engine should seek to
   * before playing.
   *
   * - If `resumeFromMs` is supplied, use it (clamped to ≥ 0).
   * - If `itemId` is supplied, look up the last session position for
   *   that item from `listening_sessions` and convert seconds → ms.
   * - Otherwise return 0 (start from the beginning).
   *
   * Then bound the result against `durationMs`: if the saved position
   * is within `COMPLETION_THRESHOLD_MS` of the end (or past it), restart
   * from 0 — finishing a lecture and re-opening it shouldn't drop the
   * user back at the credits.
   */
  resolve(input: ResumePositionInput, durationMs: number): Promise<number>
}

export function usePlayerResumePosition(): PlayerResumePositionReturn {
  const app = useLectorium()

  async function rawResume(input: ResumePositionInput): Promise<number> {
    if (input.resumeFromMs !== undefined) {
      return Math.max(0, input.resumeFromMs ?? 0)
    }
    if (!input.itemId) return 0
    const sec = await getProgressForItem(input.itemId, {
      listeningSessions: app.repositories().listeningSessions,
    })
    return sec === null ? 0 : sec * 1000
  }

  function clampToDuration(resumeMs: number, durationMs: number): number {
    if (!Number.isFinite(resumeMs) || resumeMs <= 0) return 0
    if (isCompleted(resumeMs, durationMs)) return 0
    return resumeMs
  }

  async function resolve(input: ResumePositionInput, durationMs: number): Promise<number> {
    const raw = await rawResume(input)
    return clampToDuration(raw, durationMs)
  }

  return { resolve }
}
