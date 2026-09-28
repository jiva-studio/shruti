import { beforeEach, describe, expect, it, vi } from "vitest"
import * as core from "@sentry/core"
import type { RegionProbeReport } from "@ports/app/index.js"

// The real Sentry scopes: the app's automatic fetch breadcrumbs and the
// signed-in user live on the isolation scope, not on the scope `withScope`
// forks, and are merged into every event.
vi.mock("@sentry/capacitor", async () => {
  const real = await import("@sentry/core")
  return {
    addBreadcrumb: real.addBreadcrumb,
    captureMessage: real.captureMessage,
    withScope: real.withScope,
  }
})

import {
  buildProbeTelemetry,
  createProbeTelemetry,
  PROBE_WARNED_AT_KEY,
  PROBE_WARNING_INTERVAL_MS,
} from "../probeTelemetry.js"

class TestClient extends core.Client<core.ClientOptions> {
  constructor(options: core.ClientOptions) {
    super(options)
  }
  eventFromException(exception: unknown): PromiseLike<core.Event> {
    return core.resolvedSyncPromise({ exception: { values: [{ value: String(exception) }] } })
  }
  eventFromMessage(message: core.ParameterizedString, level?: core.SeverityLevel) {
    return core.resolvedSyncPromise<core.Event>({ message: String(message), level })
  }
}

const sent: core.Event[] = []

function installClient(): void {
  const client = new TestClient({
    dsn: "https://public@sentry.invalid/1",
    integrations: [],
    stackParser: core.createStackParser(),
    transport: (options) => core.createTransport(options, async () => ({})),
    beforeSend: (event) => {
      sent.push(JSON.parse(JSON.stringify(event)) as core.Event)
      return null
    },
  })
  core.setCurrentClient(client)
  client.init()
}

/** What the running app has put on the scopes by the time a probe reports. */
function seedAppScopes(): void {
  core.getIsolationScope().clear()
  core.getCurrentScope().clear()
  core.getIsolationScope().setUser({ id: "user-123", email: "x@example.com" })
  core.addBreadcrumb({
    category: "fetch",
    data: { method: "GET", url: "https://a.example/public/config.json" },
  })
  core.addBreadcrumb({
    category: "fetch",
    data: { method: "GET", url: "https://api-a.example/healthz" },
  })
}

const CLEAN: RegionProbeReport = {
  chosenRegionId: "a",
  preferredRegionId: "a",
  fallbackUsed: false,
  attempts: [{ regionId: "a", outcome: "ok", elapsedMs: 180 }],
  networkType: "wifi",
}

/** The preferred region's API was down, but it still answered first. */
const PREFERRED_DEGRADED: RegionProbeReport = {
  chosenRegionId: "a",
  preferredRegionId: "a",
  fallbackUsed: false,
  attempts: [
    { regionId: "a", outcome: "api-down", elapsedMs: 900 },
    { regionId: "b", outcome: "api-down", elapsedMs: 950 },
  ],
}

const MOVED: RegionProbeReport = {
  chosenRegionId: "z",
  preferredRegionId: "a",
  fallbackUsed: true,
  attempts: [
    { regionId: "a", outcome: "stalled", elapsedMs: 5_000 },
    { regionId: "b", outcome: "cancelled", elapsedMs: 900 },
    { regionId: "z", outcome: "ok", elapsedMs: 400 },
  ],
}

function fakePreferences(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial }
  return {
    store,
    get: async (k: string) => store[k] ?? null,
    set: async (k: string, v: string) => {
      store[k] = v
    },
  }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)])
  }
  return []
}

/** Let the client's event pipeline — promise chains, no timers — run to `beforeSend`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  sent.length = 0
  installClient()
  seedAppScopes()
})

describe("buildProbeTelemetry", () => {
  it("carries the chosen and preferred regions, each region's outcome and timing, and the network type", () => {
    expect(buildProbeTelemetry(MOVED)).toEqual({
      chosen_region: "z",
      preferred_region: "a",
      fallback_used: true,
      attempts: "a=stalled/5000ms b=cancelled/900ms z=ok/400ms",
      network_type: "unknown",
    })
  })

  it("keeps only whitelisted fields, whatever else a report carries", () => {
    const polluted = {
      ...CLEAN,
      userId: "user-123",
      ip: "192.0.2.1",
      url: "https://a.example/public/config.json",
      attempts: [{ ...CLEAN.attempts[0]!, host: "a.example", email: "x@example.com" }],
    } as unknown as RegionProbeReport

    const all = strings(buildProbeTelemetry(polluted)).join(" ")
    expect(all).not.toMatch(/user-123|192\.0\.2\.1|example|@|https?:/)
  })
})

describe("createProbeTelemetry", () => {
  const online = () => true

  it("leaves a breadcrumb for every probe", async () => {
    const report = createProbeTelemetry({ preferences: fakePreferences(), isOnline: online })
    await report(CLEAN)
    const crumbs = core.getIsolationScope().getScopeData().breadcrumbs
    expect(crumbs.at(-1)).toMatchObject({
      category: "region.probe",
      data: buildProbeTelemetry(CLEAN),
    })
  })

  it("sends no event while the preferred region was chosen, however its checks went", async () => {
    const report = createProbeTelemetry({ preferences: fakePreferences(), isOnline: online })
    await report(CLEAN)
    await report(PREFERRED_DEGRADED)
    await settle()
    expect(sent).toHaveLength(0)
  })

  it("sends a warning when another region was chosen, with no user, URL or host in it", async () => {
    const report = createProbeTelemetry({ preferences: fakePreferences(), isOnline: online })

    await report(MOVED)
    await settle()

    expect(sent).toHaveLength(1)
    const event = sent[0]!
    expect(event.user).toBeUndefined()
    expect(event.breadcrumbs ?? []).toEqual([])
    expect(event.level).toBe("warning")
    expect(event.contexts?.region_probe).toEqual(buildProbeTelemetry(MOVED))
    expect(strings(event).join(" ")).not.toMatch(/https?:|\.example|user-123/)
  })

  it("leaves the app's own breadcrumbs and user in place for later events", async () => {
    const report = createProbeTelemetry({ preferences: fakePreferences(), isOnline: online })
    await report(MOVED)
    const data = core.getIsolationScope().getScopeData()
    expect(data.user).toMatchObject({ id: "user-123" })
    expect(data.breadcrumbs.some((b) => b.category === "fetch")).toBe(true)
  })

  it("sends a warning when no region could be chosen", async () => {
    const report = createProbeTelemetry({ preferences: fakePreferences(), isOnline: online })
    await report({ ...CLEAN, chosenRegionId: null, attempts: [] })
    await settle()
    expect(sent).toHaveLength(1)
  })

  it("never sends a warning while offline", async () => {
    const report = createProbeTelemetry({ preferences: fakePreferences(), isOnline: () => false })
    await report({ ...CLEAN, chosenRegionId: null, attempts: [] })
    await settle()
    expect(sent).toHaveLength(0)
  })

  it("sends at most one warning per interval, remembered across launches", async () => {
    let t = 1_000_000
    const prefs = fakePreferences()
    const first = createProbeTelemetry({ preferences: prefs, isOnline: online, now: () => t })
    await first(MOVED)
    expect(prefs.store[PROBE_WARNED_AT_KEY]).toBe(String(t))

    t += PROBE_WARNING_INTERVAL_MS - 1
    const relaunched = createProbeTelemetry({ preferences: prefs, isOnline: online, now: () => t })
    await relaunched(MOVED)
    await settle()
    expect(sent).toHaveLength(1)

    t += 1
    await relaunched(MOVED)
    await settle()
    expect(sent).toHaveLength(2)
  })

  it("sends one warning when two probes report at the same moment", async () => {
    const report = createProbeTelemetry({ preferences: fakePreferences(), isOnline: online })

    await Promise.all([report(MOVED), report(MOVED)])
    await settle()

    expect(sent).toHaveLength(1)
  })
})
