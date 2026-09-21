import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteAppConfig } from "@lib/domain/config.js"
import type { CdnServer } from "@lib/domain/servers.js"

const ctx = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  start: vi.fn(async () => {}),
  isReady: { value: true },
  error: { value: null as string | null },
  setActiveServerById: vi.fn(),
  activeId: "eu",
  regions: [{ id: "eu" }, { id: "us" }] as { id: string }[],
  setRegions: vi.fn(() => true),
  sweep: vi.fn(async () => {}),
  recordStorageFailure: vi.fn(),
}))

vi.mock("@kit/bootstrap", () => ({
  createBootstrapController: (opts: Record<string, unknown>) => {
    ctx.options = opts
    return { start: ctx.start, isReady: ctx.isReady, error: ctx.error }
  },
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    get activeServer() {
      return { value: { id: ctx.activeId } }
    },
    setActiveServerById: ctx.setActiveServerById,
    databaseFetcher: { delete: vi.fn() },
    serverProber: { probe: vi.fn() },
    appConfig: {
      publicRemoteConfigPath: "public/config.json",
      database: { remotePathTemplate: "r", localPathTemplate: "l" },
    },
    openContentDatabase: vi.fn(),
    closeContentDatabase: vi.fn(),
    readContentSchemeVersion: vi.fn(),
    filesStorage: { delete: vi.fn() },
    storagePublicUrl: { get: (p: string) => p },
    preferences: { set: vi.fn() },
  }),
}))
vi.mock("@shruti/services/bootstrap.js", () => ({ bootstrapUserDatabaseOrClose: vi.fn() }))
vi.mock("@shruti/services/contentDatabase.js", () => ({ sweepCatalogCopyTemps: ctx.sweep }))
vi.mock("@shruti/services/regionsRegistry.js", () => ({
  setRegions: ctx.setRegions,
  getRegions: () => ctx.regions,
  findRegion: (id: string) => ctx.regions.find((r) => r.id === id),
}))
vi.mock("@shruti/services/storageHealth.js", () => ({
  recordStorageFailure: ctx.recordStorageFailure,
}))

import { createShrutiBootstrap, runStartupBootstrap } from "../startup.js"

/** Only the id is read by the code under test; the rest of a region is
 *  irrelevant here, so the fixture fills it once. */
function region(id: string): CdnServer {
  return {
    id,
    name: id,
    urlTemplate: `https://${id}.test/{path}`,
    shareAudioUrl: `https://${id}.test/share/audio`,
    shareVideoUrl: `https://${id}.test/share/video`,
    authBaseUrl: `https://${id}.test/auth`,
    chatBaseUrl: `https://${id}.test`,
  }
}

const config = (ids: string[]): RemoteAppConfig => ({
  databases: [],
  regions: ids.map(region),
})

function onConfigResolved(): (c: RemoteAppConfig) => void {
  createShrutiBootstrap()
  const build = ctx.options!.buildResolveOptions as (
    s: ReadonlySet<string>
  ) => Record<string, unknown>
  return build(new Set()).onConfigResolved as (c: RemoteAppConfig) => void
}

beforeEach(() => {
  vi.clearAllMocks()
  ctx.isReady.value = true
  ctx.error.value = null
  ctx.activeId = "eu"
  ctx.regions = [{ id: "eu" }, { id: "us" }]
  ctx.setRegions.mockReturnValue(true)
  ctx.start.mockResolvedValue(undefined)
  ctx.sweep.mockResolvedValue(undefined)
})

describe("a freshly downloaded region list", () => {
  it("leaves the user on their region when it is still published", () => {
    onConfigResolved()(config(["eu", "us"]))
    expect(ctx.setActiveServerById).toHaveBeenCalledWith("eu")
  })

  it("moves the user to the first region when theirs is gone", () => {
    ctx.regions = [{ id: "us" }]
    onConfigResolved()(config(["us"]))
    expect(ctx.setActiveServerById).toHaveBeenCalledWith("us")
  })

  it("changes nothing when the config carries no regions", () => {
    onConfigResolved()({} as RemoteAppConfig)
    expect(ctx.setRegions).not.toHaveBeenCalled()
    expect(ctx.setActiveServerById).not.toHaveBeenCalled()
  })

  it("changes nothing when the published list is rejected", () => {
    ctx.setRegions.mockReturnValue(false)
    onConfigResolved()(config(["us"]))
    expect(ctx.setActiveServerById).not.toHaveBeenCalled()
  })
})

describe("runStartupBootstrap", () => {
  it("reports ready when the databases opened", async () => {
    expect(await runStartupBootstrap()).toEqual({ ready: true, error: null })
    expect(ctx.recordStorageFailure).not.toHaveBeenCalled()
  })

  it("answers with the failure instead of throwing it at the caller", async () => {
    ctx.start.mockRejectedValue(new Error("disk corrupt"))
    expect(await runStartupBootstrap()).toEqual({ ready: false, error: "disk corrupt" })
    expect(ctx.recordStorageFailure).toHaveBeenCalled()
  })

  it("records a bootstrap that finished without opening anything", async () => {
    ctx.isReady.value = false
    ctx.error.value = "scheme too new"
    expect(await runStartupBootstrap()).toEqual({ ready: false, error: "scheme too new" })
    expect(ctx.recordStorageFailure).toHaveBeenCalledWith("scheme too new")
  })

  it("names a reason even when the controller failed silently", async () => {
    ctx.isReady.value = false
    ctx.error.value = null
    await runStartupBootstrap()
    expect(ctx.recordStorageFailure).toHaveBeenCalledWith("content database failed to open")
  })

  it("does not let a failed temp sweep fail startup", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    ctx.sweep.mockRejectedValue(new Error("permission denied"))
    expect(await runStartupBootstrap()).toEqual({ ready: true, error: null })
    vi.restoreAllMocks()
  })
})
