export interface ServerProbeResult {
  readonly serverId: string
  readonly config: unknown
}

export interface IServerProber {
  probe(configPath: string, preferredServerId?: string): Promise<ServerProbeResult>
}

/**
 * How one region's probe ended.
 *
 * `timeout`: `config.json` did not arrive in the budget. `failed`: an error
 * answer for the config, or a config that is not JSON. `stalled`: the config
 * arrived but the ranged read of the content DB did not finish. `range-failed`:
 * the ranged read was refused or errored. `api-down`: storage passed and the
 * API health check failed or did not answer. `cancelled`: another region
 * passed first.
 */
export type RegionProbeOutcome =
  | "ok"
  | "timeout"
  | "failed"
  | "stalled"
  | "range-failed"
  | "api-down"
  | "cancelled"

export interface RegionProbeAttempt {
  readonly regionId: string
  readonly outcome: RegionProbeOutcome
  readonly elapsedMs: number
}

/**
 * One probe run, attempts in the order regions were started.
 * `chosenRegionId` is null when no region delivered a config;
 * `preferredRegionId` is the region the probe was asked to try first.
 */
export interface RegionProbeReport {
  readonly chosenRegionId: string | null
  readonly preferredRegionId: string | null
  readonly fallbackUsed: boolean
  readonly attempts: readonly RegionProbeAttempt[]
  readonly networkType?: string
}
