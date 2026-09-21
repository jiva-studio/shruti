import { isCompleted } from "@lib/domain/listeningSession.js"

/**
 * The duration completion is judged against. The catalog value can overstate a
 * denoised / re-encoded file, the engine value can be stale or missing — the
 * shorter of the two that exists keeps completion reachable either way.
 */
export function resolvePlaybackDurationMs(catalogMs: number, engineMs?: number): number {
  const engine = engineMs !== undefined && engineMs > 0 ? engineMs : 0
  const catalog = catalogMs > 0 ? catalogMs : 0
  if (catalog > 0 && engine > 0) return Math.min(catalog, engine)
  return engine || catalog
}

/**
 * Progress a completed item may show. The engine settles a few hundred ms
 * short of the reported duration, and letting that tick through would drop the
 * radial back below 100%.
 */
export function nextProgressMs(
  currentMs: number,
  incomingMs: number,
  alreadyCompleted: boolean
): number {
  return alreadyCompleted ? Math.max(currentMs, incomingMs) : incomingMs
}

/** Whether `progressMs` is far enough into `durationMs` to count as finished. */
export function reachesCompletion(progressMs: number, durationMs: number): boolean {
  return durationMs > 0 && isCompleted(progressMs, durationMs)
}
