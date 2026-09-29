import type { CdnServer } from "@lib/domain/servers.js"
import { FULL_PASS, type RegionVerdict } from "./regionCheck.js"

/** Arm a timer, returning the call that disarms it. */
export type ScheduleFn = (run: () => void, delayMs: number) => () => void

const platformSchedule: ScheduleFn = (run, delayMs) => {
  const id = setTimeout(run, delayMs)
  return () => clearTimeout(id)
}

export type CheckFn = (
  server: CdnServer,
  signal: AbortSignal,
  onConfig: () => void,
  budgetMs: number
) => Promise<RegionVerdict>

export interface RaceEntry {
  readonly server: CdnServer
  readonly verdict: RegionVerdict
}

export interface RaceOptions {
  readonly check: CheckFn
  /** How long the latest region may go without progress — its config, then
   *  its verdict — before the next one joins. */
  readonly hedgeDelayMs: number
  /** The whole race ends within this; every check gets what is left of it. */
  readonly budgetMs: number
  readonly now: () => number
  readonly schedule?: ScheduleFn
}

/**
 * Check regions in order, hedged on progress.
 *
 * The head region starts alone. The next one joins when the latest started
 * region has not fetched its config within `hedgeDelayMs`, has fetched it but
 * reached no verdict within another `hedgeDelayMs`, or ends short of a full
 * pass. A healthy head region therefore finishes alone. The first full pass
 * wins; every region still in flight is then cancelled and reported as such.
 * Each check runs on what is left of one shared budget, so the race as a
 * whole ends within `budgetMs`. Resolves with every started region's verdict,
 * in start order, once all of them have ended.
 */
export function raceRegions(
  servers: readonly CdnServer[],
  opts: RaceOptions
): Promise<readonly RaceEntry[]> {
  const schedule = opts.schedule ?? platformSchedule
  const deadlineAt = opts.now() + opts.budgetMs
  return new Promise((resolve) => {
    const entries: (RaceEntry | undefined)[] = []
    const controllers: AbortController[] = []
    let next = 0
    let running = 0
    let hasWinner = false
    let disarmHedge: (() => void) | null = null

    const clearHedge = (): void => {
      disarmHedge?.()
      disarmHedge = null
    }

    const armHedge = (): void => {
      clearHedge()
      if (next < servers.length) disarmHedge = schedule(startNext, opts.hedgeDelayMs)
    }

    const finishIfDone = (): void => {
      if (running > 0) return
      if (!hasWinner && next < servers.length) return
      clearHedge()
      resolve(entries.filter((e): e is RaceEntry => e !== undefined))
    }

    const settle = (index: number, verdict: RegionVerdict): void => {
      entries[index] = { server: servers[index]!, verdict }
      running--
      if (!hasWinner && verdict.tier === FULL_PASS) {
        hasWinner = true
        clearHedge()
        controllers.forEach((c, i) => {
          if (i !== index) c.abort()
        })
      } else if (!hasWinner) {
        startNext()
      }
      finishIfDone()
    }

    function startNext(): void {
      if (hasWinner || next >= servers.length) return
      const remainingMs = deadlineAt - opts.now()
      if (remainingMs <= 0) {
        next = servers.length
        finishIfDone()
        return
      }
      const index = next++
      const controller = new AbortController()
      controllers[index] = controller
      running++
      armHedge()

      const onConfig = (): void => {
        if (index === next - 1 && !hasWinner) armHedge()
      }
      void opts
        .check(servers[index]!, controller.signal, onConfig, remainingMs)
        .then((verdict) => settle(index, verdict))
    }

    if (servers.length === 0) {
      resolve([])
      return
    }
    startNext()
  })
}

/**
 * The best region among `entries` that satisfies `accept`: the first full
 * pass, else the one that got furthest (earliest on a tie), as long as it
 * fetched a config. Null when none did.
 */
export function pickBestRegion(
  entries: readonly RaceEntry[],
  accept: (entry: RaceEntry) => boolean = () => true
): RaceEntry | null {
  let best: RaceEntry | null = null
  for (const entry of entries) {
    if (entry.verdict.tier === 0 || !accept(entry)) continue
    if (best === null || entry.verdict.tier > best.verdict.tier) best = entry
  }
  return best
}
