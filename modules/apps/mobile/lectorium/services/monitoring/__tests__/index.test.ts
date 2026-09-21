import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, type App } from "vue"

interface SentryOptions {
  dsn?: string
  release?: string
  environment?: string
  tracesSampleRate?: number
  tracePropagationTargets?: readonly (string | RegExp)[]
  sendDefaultPii?: boolean
  beforeSend?: (event: SentryEvent, hint?: { originalException?: unknown }) => SentryEvent | null
  beforeBreadcrumb?: (crumb: { message?: string }) => { message?: string }
  integrations?: readonly string[]
}

interface SentryEvent {
  message?: string
  exception?: { values?: { value?: string }[] }
}

const inits: SentryOptions[] = []
const users: ({ id: string } | null)[] = []
const tags: [string, string][] = []
let native = false
let initThrows: Error | null = null

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native },
}))

vi.mock("@sentry/capacitor", () => ({
  init: (options: SentryOptions) => {
    if (initThrows) throw initThrows
    inits.push(options)
  },
  setUser: (user: { id: string } | null) => users.push(user),
  setTag: (key: string, value: string) => tags.push([key, value]),
}))

vi.mock("@sentry/vue", () => ({
  init: () => undefined,
  browserTracingIntegration: () => "browserTracing",
  vueIntegration: (options: { attachProps?: boolean }) =>
    `vue:attachProps=${String(options.attachProps)}`,
  captureConsoleIntegration: (options: { levels: readonly string[] }) =>
    `captureConsole:${options.levels.join(",")}`,
}))

function fakeApp(): App {
  return createApp({})
}

async function loadMonitoring() {
  vi.resetModules()
  return import("../index.js")
}

describe("initMonitoring", () => {
  beforeEach(() => {
    inits.length = 0
    users.length = 0
    tags.length = 0
    native = false
    initThrows = null
    vi.stubGlobal("__SENTRY_DSN__", "https://key@sentry.example/42")
    vi.stubGlobal("__SENTRY_RELEASE__", "lectorium@1.2.3+abc")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("stays disabled when no DSN was baked in", async () => {
    vi.stubGlobal("__SENTRY_DSN__", "")
    const { initMonitoring } = await loadMonitoring()

    initMonitoring(fakeApp())

    expect(inits).toEqual([])
  })

  it("initialises once, however many times it is called", async () => {
    const { initMonitoring } = await loadMonitoring()

    initMonitoring(fakeApp())
    initMonitoring(fakeApp())

    expect(inits).toHaveLength(1)
  })

  it("ships the release and the production environment", async () => {
    const { initMonitoring } = await loadMonitoring()

    initMonitoring(fakeApp())

    expect(inits[0].release).toBe("lectorium@1.2.3+abc")
    expect(inits[0].environment).toBe("production")
    expect(inits[0].sendDefaultPii).toBe(false)
    expect(inits[0].tracesSampleRate).toBeGreaterThan(0)
    expect(inits[0].tracePropagationTargets?.length).toBeGreaterThan(0)
  })

  it("installs the Vue, tracing and console integrations the Capacitor SDK omits", async () => {
    const { initMonitoring } = await loadMonitoring()

    initMonitoring(fakeApp())

    expect(inits[0].integrations).toEqual([
      "browserTracing",
      "vue:attachProps=false",
      "captureConsole:error",
    ])
  })

  it("survives an SDK that throws on init", async () => {
    initThrows = new Error("no native bridge")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { initMonitoring } = await loadMonitoring()

    expect(() => initMonitoring(fakeApp())).not.toThrow()
    expect(inits).toEqual([])
  })

  describe("beforeSend", () => {
    it("drops a benign error and keeps a real one", async () => {
      const { initMonitoring } = await loadMonitoring()
      initMonitoring(fakeApp())
      const beforeSend = inits[0].beforeSend!

      const benign = beforeSend({ message: "boom" }, { originalException: new Error("boom") })
      expect(benign).not.toBeNull()

      const expected = beforeSend(
        { message: "Directory already exists" },
        { originalException: new Error("Directory already exists") }
      )
      expect(expected).toBeNull()
    })

    it("redacts email from the event it forwards", async () => {
      const { initMonitoring } = await loadMonitoring()
      initMonitoring(fakeApp())

      const event = inits[0].beforeSend!({
        message: "sign-in failed for user@example.com",
        exception: { values: [{ value: "otp for user@example.com" }] },
      })

      expect(event?.message).toBe("sign-in failed for [email]")
      expect(event?.exception?.values?.[0].value).toBe("otp for [email]")
    })

    it("handles an event with no originalException at all", async () => {
      const { initMonitoring } = await loadMonitoring()
      initMonitoring(fakeApp())

      expect(inits[0].beforeSend!({ message: "manual event" })).not.toBeNull()
    })
  })

  it("redacts email from breadcrumbs", async () => {
    const { initMonitoring } = await loadMonitoring()
    initMonitoring(fakeApp())
    const beforeBreadcrumb = inits[0].beforeBreadcrumb!

    expect(beforeBreadcrumb({ message: "GET /users/a@b.co" }).message).toBe("GET /users/[email]")
    expect(beforeBreadcrumb({}).message).toBeUndefined()
  })
})

describe("monitoring scope", () => {
  beforeEach(() => {
    users.length = 0
    tags.length = 0
  })

  it("associates and clears the account id", async () => {
    const { setMonitoringUser } = await loadMonitoring()

    setMonitoringUser("acc-1")
    setMonitoringUser(null)

    expect(users).toEqual([{ id: "acc-1" }, null])
  })

  it("treats an empty id as no user rather than an empty account", async () => {
    const { setMonitoringUser } = await loadMonitoring()

    setMonitoringUser("")

    expect(users).toEqual([null])
  })

  it("tags subsequent events", async () => {
    const { setMonitoringTag } = await loadMonitoring()

    setMonitoringTag("tier", "pro")

    expect(tags).toEqual([["tier", "pro"]])
  })
})
