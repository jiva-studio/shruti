import type { DailyListeningTotal } from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"

export interface GetDailyListeningHeatmapInput {
  /** Range start (unix ms, inclusive). */
  readonly fromMs: number
  /** Range end (unix ms, exclusive). */
  readonly toMs: number
}

export interface GetDailyListeningHeatmapDeps {
  readonly listeningSessions: IListeningSessionRepository
}

export async function getDailyListeningHeatmap(
  input: GetDailyListeningHeatmapInput,
  deps: GetDailyListeningHeatmapDeps
): Promise<readonly DailyListeningTotal[]> {
  return deps.listeningSessions.getDailyTotals(input.fromMs, input.toMs)
}
