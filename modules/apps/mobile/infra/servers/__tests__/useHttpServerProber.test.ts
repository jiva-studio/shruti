import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"
import type { IServerProber, RegionProbeReport } from "@ports/app/index.js"
import { useHttpServerProber } from "../useHttpServerProber.js"
import { deriveProbeObjectPath, isUsableConfig, PROBE_RANGE_BYTES } from "../regionCheck.js"

const SCHEME = 3
const DB_TEMPLATE = "public/db/content-{version}.db"
const CONFIG_PATH = "public/config.json"
const CONFIG = { databases: [{ version: 7, scheme: SCHEME }] }
const DB_PATH = "public/db/content-7.db"

function region(id: string, extra: Partial<CdnServer> = {}): CdnServer {
  return {
    id,
    name: id,
    urlTemplate: `https://${id}.example/{path}`,
    shareAudioUrl: `https://api-${id}.example/share/audio/excerpts`,
    shareVideoUrl: `https://api-${id}.example/share/video/reels`,
    authBaseUrl: `https://api-${id}.example/auth`,
    chatBaseUrl: `https://api-${id}.example`,
    ...extra,
  }
}

type ConfigBehaviour = "ok" | "hang" | "404" | "portal" | "bad-regions" | { delayMs: number }
type RangeBehaviour = "ok" | "stall-after-16k" | "500" | "throw"
type HealthBehaviour = "ok" | "503" | "429" | "hang" | { delayMs: number }

interface Behaviour {
  readonly config?: ConfigBehaviour
  readonly range?: RangeBehaviour
  readonly health?: HealthBehaviour
}

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError")
}

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(abortError()), { once: true })
  })
}

function delayed(ms: number, signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response("ok", { status: 200 })), ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(abortError())
      },
      { once: true }
    )
  })
}

/** A body that delivers 16 KiB and then goes silent until aborted — what a
 *  throttled connection looks like from the client. */
function stalledBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024))
      signal?.addEventListener("abort", () => controller.error(abortError()), { once: true })
    },
  })
}

function healthResponse(health: HealthBehaviour, signal: AbortSignal | null | undefined) {
  if (health === "hang") return hang(signal)
  if (typeof health === "object") return delayed(health.delayMs, signal)
  const status = { ok: 200, "503": 503, "429": 429 }[health]
  return Promise.resolve(new Response("", { status }))
}

/** Routes by host: `<id>.example` is region storage, `api-<id>.example` its API. */
function fakeNetwork(behaviour: Record<string, Behaviour>) {
  const calls: string[] = []
  const ranges: (string | null)[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(url.toString())
    const signal = init?.signal
    const id = url.host.replace(/^api-/, "").replace(/\.example$/, "")
    const b = behaviour[id] ?? {}
    if (url.host.startsWith("api-")) return healthResponse(b.health ?? "ok", signal)
    if (url.pathname.endsWith("config.json")) {
      const config = b.config ?? "ok"
      if (config === "hang") return hang(signal)
      if (typeof config === "object") {
        await delayed(config.delayMs, signal)
        return new Response(JSON.stringify(CONFIG), { status: 200 })
      }
      if (config === "404") return new Response("", { status: 404 })
      // A captive portal answering the config request with JSON of its own.
      if (config === "portal")
        return new Response(JSON.stringify({ portal: true }), { status: 200 })
      if (config === "bad-regions") {
        return new Response(JSON.stringify({ ...CONFIG, regions: [] }), { status: 200 })
      }
      return new Response(JSON.stringify(CONFIG), { status: 200 })
    }
    ranges.push(new Headers(init?.headers).get("Range"))
    const range = b.range ?? "ok"
    // What a WebView does when a preflight for the Range header is refused.
    if (range === "throw") throw new TypeError("Failed to fetch")
    if (range === "500") return new Response("", { status: 500 })
    if (range === "stall-after-16k") return new Response(stalledBody(signal), { status: 206 })
    return new Response(new Uint8Array(PROBE_RANGE_BYTES), { status: 206 })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, ranges }
}

function createProber(
  servers: readonly CdnServer[],
  net: ReturnType<typeof fakeNetwork>,
  extra: { getNetworkType?: () => string | undefined } = {}
) {
  const reports: RegionProbeReport[] = []
  const prober = useHttpServerProber({
    getServers: () => servers,
    probeObjectPath: (config) => deriveProbeObjectPath(config, DB_TEMPLATE, SCHEME),
    onReport: (r) => reports.push(r),
    fetchImpl: net.fetchImpl,
    budgetMs: 150,
    now: () => Date.now(),
    hedgeDelayMs: 60,
    isValidRegionList: (list: unknown) => Array.isArray(list) && list.length > 0,
    ...extra,
  })
  return { prober, reports }
}

/** Fake time the last `drive` took, in ms. */
let lastElapsedMs = 0

/**
 * Run one probe on fake time, a millisecond at a step, until it settles.
 * Every budget, hedge and delayed answer is a fake timer, so what the probe
 * did and how long it took do not depend on how loaded the machine is.
 */
async function drive(prober: IServerProber, preferredId: string) {
  const startedAt = Date.now()
  let settled = false
  const run = prober.probe(CONFIG_PATH, preferredId)
  run.then(
    () => (settled = true),
    () => (settled = true)
  )
  while (!settled && Date.now() - startedAt < 10_000) await vi.advanceTimersByTimeAsync(1)
  lastElapsedMs = Date.now() - startedAt
  return run
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const hostsOf = (calls: readonly string[]): string[] => [
  ...new Set(calls.map((c) => new URL(c).host)),
]

function outcomesOf(report: RegionProbeReport | undefined): Record<string, string> {
  return Object.fromEntries((report?.attempts ?? []).map((x) => [x.regionId, x.outcome]))
}

describe("useHttpServerProber", () => {
  it("wins on a healthy preferred region without contacting any other", async () => {
    const net = fakeNetwork({})
    const { prober, reports } = createProber([region("a"), region("b")], net)

    const result = await drive(prober, "a")

    expect(result.serverId).toBe("a")
    expect(result.config).toEqual(CONFIG)
    expect(hostsOf(net.calls).sort()).toEqual(["a.example", "api-a.example"])
    expect(net.calls).toContain(`https://a.example/${DB_PATH}`)
    expect(net.calls).toContain("https://api-a.example/healthz")
    expect(net.ranges).toEqual([`bytes=0-${PROBE_RANGE_BYTES - 1}`])
    expect(reports).toHaveLength(1)
    expect(reports[0]!.chosenRegionId).toBe("a")
    expect(reports[0]!.preferredRegionId).toBe("a")
    expect(reports[0]!.fallbackUsed).toBe(false)
    expect(outcomesOf(reports[0])).toEqual({ a: "ok" })
  })

  it("does not hedge on a preferred region that completes within the hedge after its config", async () => {
    const net = fakeNetwork({ a: { health: { delayMs: 30 } } })
    const { prober } = createProber([region("a"), region("b")], net)

    expect((await drive(prober, "a")).serverId).toBe("a")
    expect(hostsOf(net.calls).some((h) => h.includes("b.example"))).toBe(false)
  })

  it("starts the next region when the current one has its config but not a verdict within the hedge", async () => {
    const net = fakeNetwork({ a: { health: "hang" } })
    const { prober, reports } = createProber([region("a"), region("b")], net)

    const result = await drive(prober, "a")

    // b joined one hedge (60 ms) after a's config and passed at once, long
    // before a's 150 ms budget ran out.
    expect(result.serverId).toBe("b")
    expect(lastElapsedMs).toBe(60)
    expect(net.calls).toContain("https://b.example/public/config.json")
    expect(outcomesOf(reports[0])).toEqual({ a: "cancelled", b: "ok" })
  })

  it("measures the second hedge from when the config arrived", async () => {
    const net = fakeNetwork({ a: { config: { delayMs: 40 }, health: "hang" } })
    const { prober } = createProber([region("a"), region("b")], net)

    const result = await drive(prober, "a")

    // a's config at 40 ms re-arms the hedge, so b joins at 100 ms, not 60.
    expect(result.serverId).toBe("b")
    expect(lastElapsedMs).toBe(100)
  })

  it("ends within one budget when every API hangs", async () => {
    const hanging = { health: "hang" } as const
    const net = fakeNetwork({ a: hanging, b: hanging, c: hanging, d: hanging })
    const servers = [region("a"), region("b"), region("c"), region("d")]
    const { prober, reports } = createProber(servers, net)

    const result = await drive(prober, "a")

    // a at 0, b one hedge later, c one more: all three end with the shared
    // 150 ms budget instead of each running a budget of its own, and d, due
    // after the budget ran out, is never started.
    expect(result.serverId).toBe("a")
    expect(lastElapsedMs).toBe(150)
    expect(net.calls.filter((c) => c.endsWith("/healthz"))).toEqual([
      "https://api-a.example/healthz",
      "https://api-b.example/healthz",
      "https://api-c.example/healthz",
    ])
    expect(outcomesOf(reports[0])).toEqual({ a: "api-down", b: "api-down", c: "api-down" })
  })

  it("does not take a captive portal's JSON for a config", async () => {
    const net = fakeNetwork({ a: { config: "portal" } })
    const { prober, reports } = createProber([region("a"), region("b")], net)

    expect((await drive(prober, "a")).serverId).toBe("b")
    expect(outcomesOf(reports[0]).a).toBe("failed")
  })

  it("does not take a config whose region list is invalid", async () => {
    const net = fakeNetwork({ a: { config: "bad-regions" } })
    const { prober, reports } = createProber([region("a"), region("b")], net)

    expect((await drive(prober, "a")).serverId).toBe("b")
    expect(outcomesOf(reports[0]).a).toBe("failed")
  })

  it("cancels a slower region once another passes, and reports it cancelled", async () => {
    const net = fakeNetwork({ a: { config: "hang" } })
    const { prober, reports } = createProber([region("a"), region("b")], net)

    expect((await drive(prober, "a")).serverId).toBe("b")
    expect(outcomesOf(reports[0])).toEqual({ a: "cancelled", b: "ok" })
  })

  it("prefers a region that passes over one whose connection stalls after the first 16 KiB", async () => {
    const net = fakeNetwork({ a: { range: "stall-after-16k" } })
    const { prober, reports } = createProber([region("a"), region("b")], net)

    // b joins a hedge after a's config and passes while a is still stalled.
    expect((await drive(prober, "a")).serverId).toBe("b")
    expect(outcomesOf(reports[0])).toEqual({ a: "cancelled", b: "ok" })
  })

  it("prefers a region that passes over one whose API is down", async () => {
    const net = fakeNetwork({ a: { health: "503" } })
    const { prober, reports } = createProber([region("a"), region("b")], net)

    expect((await drive(prober, "a")).serverId).toBe("b")
    expect(outcomesOf(reports[0]).a).toBe("api-down")
  })

  it("counts an API that never answers as down", async () => {
    const net = fakeNetwork({ a: { health: "hang" } })
    const { prober, reports } = createProber([region("a")], net)

    expect((await drive(prober, "a")).serverId).toBe("a")
    expect(outcomesOf(reports[0])).toEqual({ a: "api-down" })
  })

  it("counts an API that answers 429 as up", async () => {
    const net = fakeNetwork({ a: { health: "429" } })
    const { prober, reports } = createProber([region("a"), region("b")], net)

    expect((await drive(prober, "a")).serverId).toBe("a")
    expect(outcomesOf(reports[0])).toEqual({ a: "ok" })
  })

  it("still applies the config when every API is down but storage answers", async () => {
    const net = fakeNetwork({ a: { health: "503" }, b: { health: "hang" } })
    const reserve = region("z", { fallbackOnly: true })
    const { prober, reports } = createProber([region("a"), region("b"), reserve], net)

    const result = await drive(prober, "a")

    expect(result.serverId).toBe("a")
    expect(result.config).toEqual(CONFIG)
    expect(reports[0]!.fallbackUsed).toBe(false)
    expect(outcomesOf(reports[0])).toEqual({ a: "api-down", b: "api-down" })
  })

  it("still applies the config when every ranged read is refused", async () => {
    const net = fakeNetwork({ a: { range: "throw" }, b: { range: "throw" } })
    const { prober, reports } = createProber([region("a"), region("b")], net)

    const result = await drive(prober, "a")

    expect(result.serverId).toBe("a")
    expect(result.config).toEqual(CONFIG)
    expect(outcomesOf(reports[0])).toEqual({ a: "range-failed", b: "range-failed" })
  })

  it("ranks storage-without-API above config-only", async () => {
    const net = fakeNetwork({ a: { range: "stall-after-16k" }, b: { health: "503" } })
    const { prober } = createProber([region("a"), region("b")], net)

    expect((await drive(prober, "a")).serverId).toBe("b")
  })

  it("reports a region whose config never arrives as a timeout", async () => {
    const net = fakeNetwork({ a: { config: "hang" }, b: { config: "404" } })
    const { prober, reports } = createProber([region("a"), region("b")], net)

    await expect(drive(prober, "a")).rejects.toThrow()
    expect(outcomesOf(reports[0])).toEqual({ a: "timeout", b: "failed" })
  })

  it("never contacts a fallback-only region while a regular one reaches storage", async () => {
    const net = fakeNetwork({ a: { health: "503" } })
    const reserve = region("z", { fallbackOnly: true })
    // Declared first and preferred: neither may pull it into the race.
    const { prober, reports } = createProber([reserve, region("a")], net)

    const result = await drive(prober, "z")

    expect(result.serverId).toBe("a")
    expect(hostsOf(net.calls).some((h) => h.includes("z.example"))).toBe(false)
    expect(reports[0]!.fallbackUsed).toBe(false)
  })

  it("moves to a fallback-only region whose storage answers when every regular region stalls", async () => {
    const net = fakeNetwork({ a: { range: "stall-after-16k" }, b: { range: "stall-after-16k" } })
    const reserve = region("z", { fallbackOnly: true })
    const { prober, reports } = createProber([region("a"), region("b"), reserve], net)

    const result = await drive(prober, "a")

    expect(result.serverId).toBe("z")
    expect(result.config).toEqual(CONFIG)
    expect(reports[0]!.fallbackUsed).toBe(true)
    expect(outcomesOf(reports[0])).toEqual({ a: "stalled", b: "stalled", z: "ok" })
  })

  it("keeps a regular region's config over a fallback-only region that also only delivers a config", async () => {
    const net = fakeNetwork({
      a: { range: "stall-after-16k" },
      z: { range: "stall-after-16k" },
    })
    const reserve = region("z", { fallbackOnly: true })
    const { prober, reports } = createProber([region("a"), reserve], net)

    expect((await drive(prober, "a")).serverId).toBe("a")
    expect(reports[0]!.fallbackUsed).toBe(false)
  })

  it("probes a fallback-only region when no regular region delivered a config, without its API", async () => {
    const net = fakeNetwork({ a: { config: "404" }, b: { config: "hang" } })
    const reserve = region("z", { fallbackOnly: true })
    const { prober, reports } = createProber([region("a"), region("b"), reserve], net)

    const result = await drive(prober, "a")

    expect(result.serverId).toBe("z")
    expect(net.calls).not.toContain("https://api-z.example/healthz")
    expect(reports[0]!.chosenRegionId).toBe("z")
    expect(reports[0]!.fallbackUsed).toBe(true)
    expect(outcomesOf(reports[0])).toEqual({ a: "failed", b: "timeout", z: "ok" })
  })

  it("leaves a fallback-only region when a regular one is reachable again", async () => {
    const net = fakeNetwork({})
    const reserve = region("z", { fallbackOnly: true })
    const { prober } = createProber([region("a"), reserve], net)

    expect((await drive(prober, "z")).serverId).toBe("a")
  })

  it("rejects and reports no choice when no region delivers a config", async () => {
    const net = fakeNetwork({ a: { config: "404" }, z: { config: "404" } })
    const reserve = region("z", { fallbackOnly: true })
    const { prober, reports } = createProber([region("a"), reserve], net)

    await expect(drive(prober, "a")).rejects.toThrow()
    expect(reports[0]!.chosenRegionId).toBeNull()
    expect(reports[0]!.attempts.map((x) => x.outcome)).toEqual(["failed", "failed"])
  })

  it("carries the network type into the report when one is known", async () => {
    const net = fakeNetwork({})
    const { prober, reports } = createProber([region("a")], net, {
      getNetworkType: () => "cellular",
    })

    await drive(prober, "a")

    expect(reports[0]!.networkType).toBe("cellular")
  })
})

describe("isUsableConfig", () => {
  const anyList = () => true

  it("accepts a config listing its databases, with or without a valid region list", () => {
    expect(isUsableConfig(CONFIG, anyList)).toBe(true)
    expect(isUsableConfig({ ...CONFIG, regions: [{ id: "a" }] }, anyList)).toBe(true)
  })

  it("rejects a config with no database, a malformed one, or a region list the registry refuses", () => {
    expect(isUsableConfig({ databases: [] }, anyList)).toBe(false)
    expect(isUsableConfig({ databases: [{ version: "7" }] }, anyList)).toBe(false)
    expect(isUsableConfig({ ...CONFIG, regions: [] }, () => false)).toBe(false)
    expect(isUsableConfig("<html>", anyList)).toBe(false)
  })
})

describe("deriveProbeObjectPath", () => {
  it("targets the latest database this build can read", () => {
    const config = {
      databases: [
        { version: 5, scheme: SCHEME },
        { version: 9, scheme: SCHEME + 1 },
        { version: 7, scheme: SCHEME },
      ],
    }
    expect(deriveProbeObjectPath(config, DB_TEMPLATE, SCHEME)).toBe("public/db/content-7.db")
  })

  it("falls back to the latest listed database when none matches the scheme", () => {
    const config = {
      databases: [
        { version: 4, scheme: 1 },
        { version: 6, scheme: 2 },
      ],
    }
    expect(deriveProbeObjectPath(config, DB_TEMPLATE, SCHEME)).toBe("public/db/content-6.db")
  })

  it("has nothing to target when the config lists no database", () => {
    expect(deriveProbeObjectPath({}, DB_TEMPLATE, SCHEME)).toBeNull()
    expect(deriveProbeObjectPath(null, DB_TEMPLATE, SCHEME)).toBeNull()
  })
})
