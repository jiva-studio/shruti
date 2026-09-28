import { buildVersionedPath, findLatestCompatibleVersion } from "@kit/bootstrap"
import { buildServerUrl, joinUrl } from "@kit/servers"
import type { CdnServer } from "@lib/domain/servers.js"
import type { RegionProbeOutcome } from "@ports/app/index.js"

/**
 * How much of the content database a probe reads. Some networks let the first
 * ~16 KB of a connection through and then stall it, so a region only counts as
 * fully reachable once it has delivered well past that point.
 */
export const PROBE_RANGE_BYTES = 64 * 1024

interface ListedDatabase {
  readonly version: number
  readonly scheme?: number
}

function readDatabases(config: unknown): ListedDatabase[] {
  if (typeof config !== "object" || config === null) return []
  const list = (config as { databases?: unknown }).databases
  if (!Array.isArray(list)) return []
  return list.filter(
    (d): d is ListedDatabase =>
      typeof d === "object" && d !== null && typeof (d as ListedDatabase).version === "number"
  )
}

/**
 * The storage path of the content database a probe reads from: the one this
 * build would download, or the latest listed when none matches its scheme.
 * Every listed database is published and far larger than the probe read.
 * Null when the config lists none.
 */
export function deriveProbeObjectPath(
  config: unknown,
  remotePathTemplate: string,
  supportedScheme: number
): string | null {
  const databases = readDatabases(config)
  if (databases.length === 0) return null
  const version =
    findLatestCompatibleVersion({ databases }, supportedScheme) ??
    Math.max(...databases.map((d) => d.version))
  return buildVersionedPath(remotePathTemplate, version)
}

/**
 * How far a region got, best last: nothing usable, `config.json` only, config
 * and storage but no API, everything. A region is chosen by tier, so a check
 * that fails after the config arrived never throws the config away.
 */
export type RegionTier = 0 | 1 | 2 | 3

export const FULL_PASS: RegionTier = 3

export interface RegionVerdict {
  readonly outcome: RegionProbeOutcome
  readonly tier: RegionTier
  readonly config: unknown
  readonly elapsedMs: number
}

export interface RegionCheckOptions {
  readonly configPath: string
  /** Whether the region's API must answer `/healthz` for a full pass. */
  readonly requireApi: boolean
  /** Whether a parsed `config.json` is one this app can use (see `isUsableConfig`). */
  readonly isUsableConfig: (config: unknown) => boolean
  readonly probeObjectPath: (config: unknown) => string | null
  readonly fetchImpl: typeof fetch
  readonly now: () => number
}

type StepState = "pending" | "ok" | "failed"

interface CheckState {
  config: unknown
  hasConfig: boolean
  storage: StepState
  api: StepState
}

function classify(state: CheckState, requireApi: boolean, timedOut: boolean) {
  if (!state.hasConfig) return { outcome: timedOut ? "timeout" : "failed", tier: 0 } as const
  if (state.storage === "pending") return { outcome: "stalled", tier: 1 } as const
  if (state.storage === "failed") return { outcome: "range-failed", tier: 1 } as const
  if (requireApi && state.api !== "ok") return { outcome: "api-down", tier: 2 } as const
  return { outcome: "ok", tier: FULL_PASS } as const
}

/**
 * A config is usable only if it lists at least one database with a numeric
 * version and, when it carries a region list, that list is valid. Anything
 * else — a captive portal's own JSON, a truncated publish — is not a config.
 */
export function isUsableConfig(
  config: unknown,
  isValidRegionList: (list: unknown) => boolean
): boolean {
  if (typeof config !== "object" || config === null) return false
  const { databases, regions } = config as { databases?: unknown; regions?: unknown }
  if (!Array.isArray(databases) || databases.length === 0) return false
  if (readDatabases(config).length !== databases.length) return false
  return regions === undefined || isValidRegionList(regions)
}

/**
 * Check one region end to end: `config.json`, a ranged read of the content
 * database and, when required, the API health endpoint, all inside
 * `budgetMs`. `onConfig` fires the moment a usable config has arrived — what
 * the race hedges on. Never rejects: every way a region can fail is a verdict.
 */
export async function checkRegion(
  server: CdnServer,
  signal: AbortSignal,
  onConfig: () => void,
  budgetMs: number,
  opts: RegionCheckOptions
): Promise<RegionVerdict> {
  const startedAt = opts.now()
  const local = new AbortController()
  const onAbort = (): void => local.abort()
  signal.addEventListener("abort", onAbort, { once: true })
  const state: CheckState = {
    config: undefined,
    hasConfig: false,
    storage: "pending",
    api: "pending",
  }
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve()
    }, budgetMs)
  })

  try {
    await Promise.race([runChecks(server, local.signal, state, onConfig, opts), deadline])
  } catch {
    // A config that failed or is not JSON leaves `hasConfig` false; a later
    // step failing is already in `state`. Either way the verdict says it.
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
    local.abort()
  }

  const elapsedMs = opts.now() - startedAt
  if (signal.aborted) {
    return { outcome: "cancelled", tier: 0, config: state.config, elapsedMs }
  }
  return { ...classify(state, opts.requireApi, timedOut), config: state.config, elapsedMs }
}

async function runChecks(
  server: CdnServer,
  signal: AbortSignal,
  state: CheckState,
  onConfig: () => void,
  opts: RegionCheckOptions
): Promise<void> {
  const response = await opts.fetchImpl(buildServerUrl(server, opts.configPath), { signal })
  if (!response.ok) return
  const config: unknown = await response.json()
  if (!opts.isUsableConfig(config)) return
  state.config = config
  state.hasConfig = true
  onConfig()

  const objectPath = opts.probeObjectPath(state.config)
  const api = opts.requireApi
    ? checkHealth(opts.fetchImpl, joinUrl(server.chatBaseUrl, "/healthz"), signal).then((ok) => {
        state.api = ok ? "ok" : "failed"
      })
    : Promise.resolve()
  state.storage = objectPath
    ? await readPrefix(opts.fetchImpl, buildServerUrl(server, objectPath), signal).then(
        (ok): StepState => (ok ? "ok" : "failed"),
        (): StepState => (signal.aborted ? "pending" : "failed")
      )
    : "ok"
  if (state.storage === "ok") await api
}

/** Read the first `PROBE_RANGE_BYTES` of `url`. A server that ignores the
 *  Range header and sends the whole object is read that far and cut off. */
async function readPrefix(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal
): Promise<boolean> {
  const response = await fetchImpl(url, {
    headers: { Range: `bytes=0-${PROBE_RANGE_BYTES - 1}` },
    signal,
  })
  if (!response.ok) return false
  if (!response.body) {
    await response.arrayBuffer()
    return true
  }
  const reader = response.body.getReader()
  let received = 0
  while (received < PROBE_RANGE_BYTES) {
    const { done, value } = await reader.read()
    if (done) return true
    received += value.byteLength
  }
  // Enough has arrived; the rest of the body is not wanted. A cancel that
  // fails leaves a stream nobody reads, which the abort in `checkRegion`
  // tears down anyway.
  await reader.cancel().catch(() => undefined)
  return true
}

/**
 * Whether the API answers at all. A 429 is the edge rate-limiting this client,
 * which is an API that is up.
 */
async function checkHealth(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { signal })
    return response.ok || response.status === 429
  } catch {
    return false
  }
}
