import type { CdnServer } from "@lib/domain/servers.js"
import type {
  IServerProber,
  RegionProbeAttempt,
  RegionProbeReport,
  ServerProbeResult,
} from "@ports/app/index.js"
import { orderProbeCandidates } from "./probeOrder.js"
import { checkRegion, FULL_PASS, isUsableConfig } from "./regionCheck.js"
import { pickBestRegion, raceRegions, type RaceEntry, type ScheduleFn } from "./regionRace.js"

/**
 * Budget for one race of regions: config, a 64 KiB ranged read and the API
 * health endpoint for each. A stalled connection is only visible as the
 * absence of bytes, so this is also how long a stall takes to be declared.
 */
const DEFAULT_BUDGET_MS = 5_000

/** How long a region may go without progress before the next joins. */
const DEFAULT_HEDGE_DELAY_MS = 1_000

export interface HttpServerProberDeps {
  readonly getServers: () => readonly CdnServer[]
  /** The content-database path to read from a fetched config, or null. */
  readonly probeObjectPath: (config: unknown) => string | null
  /** Whether a config's `regions` block is one the registry would accept. */
  readonly isValidRegionList: (list: unknown) => boolean
  readonly onReport?: (report: RegionProbeReport) => void
  readonly getNetworkType?: () => string | undefined
  readonly fetchImpl?: typeof fetch
  readonly budgetMs?: number
  readonly hedgeDelayMs?: number
  readonly now?: () => number
  readonly schedule?: ScheduleFn
}

function toAttempts(entries: readonly RaceEntry[]): RegionProbeAttempt[] {
  return entries.map((e) => ({
    regionId: e.server.id,
    outcome: e.verdict.outcome,
    elapsedMs: e.verdict.elapsedMs,
  }))
}

function buildReport(
  entries: readonly RaceEntry[],
  chosen: RaceEntry | null,
  preferredServerId: string | undefined,
  fallback: readonly CdnServer[],
  networkType: string | undefined
): RegionProbeReport {
  return {
    chosenRegionId: chosen?.server.id ?? null,
    preferredRegionId: preferredServerId ?? null,
    fallbackUsed: chosen !== null && fallback.includes(chosen.server),
    attempts: toAttempts(entries),
    ...(networkType ? { networkType } : {}),
  }
}

/** A regular region whose storage answered: its API may be down, but it serves. */
const reachedStorage = (entry: RaceEntry): boolean => entry.verdict.tier >= 2

/** A fallback-only region's full pass is its storage answering. */
const isFullPass = (entry: RaceEntry): boolean => entry.verdict.tier === FULL_PASS

/**
 * The region to use. Fallback-only regions have raced only when no regular
 * region reached storage, so the order is: a fallback-only region that
 * reached storage, then the regular region that got furthest (which reached
 * storage whenever any did), then a fallback-only region that only delivered
 * a config.
 */
function chooseRegion(
  regular: readonly RaceEntry[],
  fallback: readonly RaceEntry[]
): RaceEntry | null {
  return pickBestRegion(fallback, isFullPass) ?? pickBestRegion(regular) ?? pickBestRegion(fallback)
}

/**
 * HTTP-backed `IServerProber`.
 *
 * Regular regions race first, preferred first, each checked end to end (see
 * `checkRegion`), within one budget. The first full pass wins. When no
 * regular region's storage answered — every one stalled, refused the ranged
 * read, or sent no config — fallback-only regions race too, storage only,
 * within a budget of their own. The region is then chosen by
 * `chooseRegion`, so a config that arrived is never thrown away.
 */
export function useHttpServerProber(deps: HttpServerProberDeps): IServerProber {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init))
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS
  const hedgeDelayMs = deps.hedgeDelayMs ?? DEFAULT_HEDGE_DELAY_MS
  const now = deps.now ?? Date.now
  const usable = (config: unknown): boolean => isUsableConfig(config, deps.isValidRegionList)

  function race(
    servers: readonly CdnServer[],
    configPath: string,
    requireApi: boolean
  ): Promise<readonly RaceEntry[]> {
    const checkOpts = {
      configPath,
      requireApi,
      isUsableConfig: usable,
      probeObjectPath: deps.probeObjectPath,
      fetchImpl,
      now,
    }
    return raceRegions(servers, {
      check: (server, signal, onConfig, remainingMs) =>
        checkRegion(server, signal, onConfig, remainingMs, checkOpts),
      hedgeDelayMs,
      budgetMs,
      now,
      ...(deps.schedule ? { schedule: deps.schedule } : {}),
    })
  }

  return {
    async probe(configPath, preferredServerId) {
      const { regular, fallback } = orderProbeCandidates(deps.getServers(), preferredServerId)
      const regularEntries = await race(regular, configPath, true)
      const fallbackEntries = regularEntries.some(reachedStorage)
        ? []
        : await race(fallback, configPath, false)
      const chosen = chooseRegion(regularEntries, fallbackEntries)

      const entries = [...regularEntries, ...fallbackEntries]
      const networkType = deps.getNetworkType?.()
      deps.onReport?.(buildReport(entries, chosen, preferredServerId, fallback, networkType))
      if (chosen === null) throw new Error("All servers are unreachable")
      return {
        serverId: chosen.server.id,
        config: chosen.verdict.config,
      } satisfies ServerProbeResult
    },
  }
}
