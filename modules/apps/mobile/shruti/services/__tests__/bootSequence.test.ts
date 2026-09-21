import { beforeEach, describe, expect, it, vi } from "vitest"

const ctx = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    localeReady: { resolve: () => {} } as { resolve: () => void },
    applyStoredAppLanguage: vi.fn(),
    hydrateRegions: vi.fn(async () => {
      ctx.order.push("hydrate")
    }),
    findRegion: vi.fn(() => ({ id: "eu" })),
    readPreferredServerId: vi.fn(async () => "eu"),
    setActiveServerById: vi.fn((id: string) => ctx.order.push(`activate:${id}`)),
    runStartupBootstrap: vi.fn(async () => {
      ctx.order.push("bootstrap")
      return { ready: true, error: undefined as string | undefined }
    }),
    startRegionWatch: vi.fn(() => ctx.order.push("watch")),
    resolveInitialRoute: vi.fn(async () => {
      ctx.order.push("route")
      return "/tabs/home"
    }),
    runPostMountWork: vi.fn(() => ctx.order.push("post-mount")),
    reportError: vi.fn(),
    replace: vi.fn(async () => {}),
    currentRoute: { value: { path: "/", query: {} as Record<string, string> } },
  }
})

vi.mock("@shruti/router/index.js", () => ({
  default: {
    isReady: async () => {},
    replace: ctx.replace,
    get currentRoute() {
      return ctx.currentRoute
    },
  },
}))
vi.mock("@shruti/i18n/index.js", () => ({ bootLocaleReady: Promise.resolve() }))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({
  applyStoredAppLanguage: ctx.applyStoredAppLanguage,
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({ setActiveServerById: ctx.setActiveServerById }),
}))
vi.mock("@shruti/services/regionsRegistry.js", () => ({
  hydrateRegions: ctx.hydrateRegions,
  findRegion: ctx.findRegion,
}))
vi.mock("@shruti/services/preferredServer.js", () => ({
  readPreferredServerId: ctx.readPreferredServerId,
}))
vi.mock("@shruti/services/startup.js", () => ({
  runStartupBootstrap: ctx.runStartupBootstrap,
}))
vi.mock("@shruti/services/regionWatch.js", () => ({ startRegionWatch: ctx.startRegionWatch }))
vi.mock("@shruti/services/startupRoute.js", () => ({
  resolveInitialRoute: ctx.resolveInitialRoute,
}))
vi.mock("@shruti/services/postMount.js", () => ({ runPostMountWork: ctx.runPostMountWork }))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({ reportError: ctx.reportError }))

import { runBootSequence } from "../bootSequence.js"

const prefs = {} as never

function mount() {
  return vi.fn(() => ctx.order.push("mount"))
}

beforeEach(() => {
  vi.clearAllMocks()
  ctx.order.length = 0
  ctx.currentRoute = { value: { path: "/", query: { locale: "ru" } } }
  ctx.applyStoredAppLanguage.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        ctx.localeReady.resolve = () => {
          ctx.order.push("ui-language")
          resolve()
        }
        queueMicrotask(() => ctx.localeReady.resolve())
      })
  )
  ctx.findRegion.mockReturnValue({ id: "eu" })
  ctx.readPreferredServerId.mockResolvedValue("eu")
  ctx.runStartupBootstrap.mockImplementation(async () => {
    ctx.order.push("bootstrap")
    return { ready: true, error: undefined }
  })
})

describe("runBootSequence", () => {
  it("activates the user's last pick before the bootstrap probe", async () => {
    await runBootSequence(prefs, mount())
    expect(ctx.order.indexOf("activate:eu")).toBeLessThan(ctx.order.indexOf("bootstrap"))
    expect(ctx.order.indexOf("hydrate")).toBeLessThan(ctx.order.indexOf("activate:eu"))
  })

  it("ignores a stored region the hydrated list no longer holds", async () => {
    ctx.findRegion.mockReturnValue(undefined as never)
    await runBootSequence(prefs, mount())
    expect(ctx.setActiveServerById).not.toHaveBeenCalled()
  })

  it("leaves the region alone when nothing was stored", async () => {
    ctx.readPreferredServerId.mockResolvedValue(null as never)
    await runBootSequence(prefs, mount())
    expect(ctx.setActiveServerById).not.toHaveBeenCalled()
  })

  it("still mounts when region hydration fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    ctx.hydrateRegions.mockRejectedValue(new Error("no config"))
    const mountApp = mount()
    await runBootSequence(prefs, mountApp)
    expect(mountApp).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it("reports a content database that would not open, and mounts anyway", async () => {
    ctx.runStartupBootstrap.mockImplementation(async () => {
      ctx.order.push("bootstrap")
      return { ready: false, error: "disk corrupt" }
    })
    const mountApp = mount()
    await runBootSequence(prefs, mountApp)
    expect(ctx.reportError).toHaveBeenCalledWith("startup", expect.any(Error))
    expect(ctx.reportError.mock.calls[0][1]).toMatchObject({ message: "disk corrupt" })
    expect(mountApp).toHaveBeenCalledTimes(1)
    expect(ctx.resolveInitialRoute).toHaveBeenCalledWith(expect.anything(), prefs, false)
  })

  it("settles the chosen UI language before the route is resolved", async () => {
    await runBootSequence(prefs, mount())
    expect(ctx.order.indexOf("ui-language")).toBeLessThan(ctx.order.indexOf("route"))
    expect(ctx.order.indexOf("ui-language")).toBeLessThan(ctx.order.indexOf("mount"))
  })

  it("keeps the region following the device after the one bootstrap probe", async () => {
    await runBootSequence(prefs, mount())
    expect(ctx.order.indexOf("bootstrap")).toBeLessThan(ctx.order.indexOf("watch"))
  })

  it("navigates to the resolved route, keeping the query", async () => {
    await runBootSequence(prefs, mount())
    expect(ctx.replace).toHaveBeenCalledWith({
      path: "/tabs/home",
      query: { locale: "ru" },
    })
  })

  it("does not navigate when the router is already there", async () => {
    ctx.currentRoute = { value: { path: "/tabs/home", query: {} } }
    await runBootSequence(prefs, mount())
    expect(ctx.replace).not.toHaveBeenCalled()
  })

  it("runs the post-mount work only after the app is mounted", async () => {
    await runBootSequence(prefs, mount())
    expect(ctx.order.indexOf("mount")).toBeLessThan(ctx.order.indexOf("post-mount"))
  })
})
