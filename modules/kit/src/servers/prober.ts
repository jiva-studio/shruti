import { buildServerUrl } from "./cdnServer.js"

/**
 * Result of a successful server probe: the id of the server that responded
 * first, plus the parsed JSON body it returned (the probe doubles as the
 * config download for the winning server).
 */
export interface ServerProbeResult<T = unknown> {
  readonly serverId: string
  readonly config: T
}

export interface ProbeServersOptions {
  /** Path substituted into each server's `{path}` template to form the probe
   *  URL. Typically the remote config path. */
  configPath: string
  /** Try this server first if present in the list. */
  preferredServerId?: string
  /** Per-probe abort timeout in milliseconds. Default: 2500. */
  timeoutMs?: number
  /** How long to wait for the candidate in flight before hedging with the
   *  next one. Default: 400. */
  hedgeDelayMs?: number
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

const HEDGE = Symbol("hedge")

interface Settled<T> {
  readonly index: number
  readonly result: ServerProbeResult<T> | undefined
}

/**
 * Probe a list of candidate servers and return the first that responds with
 * valid JSON for `configPath`, along with the parsed body. The preferred
 * server (if any) goes first; the rest follow in declared order.
 *
 * Candidates are hedged, not raced flat out: only the head candidate starts
 * immediately, the next joins after `hedgeDelayMs` — or straight away if the
 * one in flight fails first, so a fast failure never costs the hedge window.
 * A healthy head server therefore still wins alone, one request per launch,
 * while a blackholed one no longer blocks the field for a full `timeoutMs`.
 * Each probe is bounded by `timeoutMs` via an `AbortController` that stays
 * armed across the body read; losers are aborted as soon as a winner appears.
 *
 * Generic over the server shape — kit only needs `id` and `urlTemplate`.
 *
 * Throws if every candidate is unreachable / returns non-OK / non-JSON.
 */
export async function probeServers<S extends { id: string; urlTemplate: string }, T = unknown>(
  servers: readonly S[],
  opts: ProbeServersOptions
): Promise<ServerProbeResult<T>> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 2500
  const hedgeDelayMs = opts.hedgeDelayMs ?? 400
  const ordered = buildOrderedList(servers, opts.preferredServerId)

  const controllers: AbortController[] = []
  const inFlight = new Map<number, Promise<Settled<T>>>()
  let next = 0

  const start = () => {
    const index = next++
    const server = ordered[index]
    const controller = new AbortController()
    controllers[index] = controller
    inFlight.set(
      index,
      probeOne<T>(fetchImpl, buildServerUrl(server, opts.configPath), controller, timeoutMs).then(
        (result) => ({ index, result: result && { serverId: server.id, config: result.config } })
      )
    )
  }

  try {
    if (ordered.length > 0) start()

    while (inFlight.size > 0) {
      const hedge = next < ordered.length ? createHedge(hedgeDelayMs) : undefined
      const racers: Promise<Settled<T> | typeof HEDGE>[] = [...inFlight.values()]
      if (hedge) racers.push(hedge.promise)

      const won = await Promise.race(racers)
      hedge?.cancel()

      if (won === HEDGE) {
        start()
        continue
      }
      inFlight.delete(won.index)
      if (won.result) return won.result
      if (next < ordered.length) start()
    }
  } finally {
    for (const controller of controllers) controller.abort()
  }

  throw new Error("All servers are unreachable")
}

async function probeOne<T>(
  fetchImpl: typeof fetch,
  url: string,
  controller: AbortController,
  timeoutMs: number
): Promise<{ config: T } | undefined> {
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("Probe aborted")), {
      once: true,
    })
  })
  try {
    return await Promise.race([read<T>(fetchImpl, url, controller.signal), aborted])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function read<T>(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal
): Promise<{ config: T } | undefined> {
  const response = await fetchImpl(url, { signal })
  if (!response.ok) return undefined
  return { config: (await response.json()) as T }
}

function createHedge(ms: number): { promise: Promise<typeof HEDGE>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<typeof HEDGE>((resolve) => {
    timer = setTimeout(() => resolve(HEDGE), ms)
  })
  return { promise, cancel: () => clearTimeout(timer) }
}

function buildOrderedList<S extends { id: string }>(
  servers: readonly S[],
  preferredServerId?: string
): S[] {
  if (!preferredServerId) return [...servers]
  const preferred = servers.find((s) => s.id === preferredServerId)
  if (!preferred) return [...servers]
  return [preferred, ...servers.filter((s) => s.id !== preferredServerId)]
}
