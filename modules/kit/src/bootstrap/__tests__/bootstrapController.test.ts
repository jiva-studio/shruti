import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createBootstrapController } from "../bootstrapController.js"
import type {
  ContentDatabaseStore,
  ResolveContentDatabaseOptions,
  ProbeResult,
} from "../contentDatabaseResolver.js"

interface TestConfig {
  databases?: ReadonlyArray<{ version: number; scheme?: number }>
}

const TEMPLATE = "app/databases/app.{version}.db"

function makeStore(over: Partial<ContentDatabaseStore> = {}): ContentDatabaseStore {
  return {
    list: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    download: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...over,
  }
}

function buildResolveOptions(
  store: ContentDatabaseStore,
  config: TestConfig,
  probe = vi.fn(
    async (): Promise<ProbeResult<TestConfig>> => ({
      server: { id: "s1", urlTemplate: "https://cdn/{path}" },
      config,
    })
  )
): {
  factory: (s: ReadonlySet<string>) => ResolveContentDatabaseOptions<TestConfig>
  probe: typeof probe
} {
  const factory = (
    incompatibleDbPaths: ReadonlySet<string>
  ): ResolveContentDatabaseOptions<TestConfig> => ({
    store,
    probe,
    configPath: "public/config.json",
    remotePathTemplate: "remote/app.{version}.db",
    localPathTemplate: TEMPLATE,
    supportedScheme: 7,
    incompatibleDbPaths,
  })
  return { factory, probe }
}

/** Wait for all pending microtasks / fire-and-forget background work. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

describe("createBootstrapController — SWR decision", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("local present → instant start, no foreground download, background refresh scheduled", async () => {
    const store = makeStore({
      list: vi.fn(async () => ["app.42.db"]),
      // The cached file passes the integrity gate; the newer version (50) the
      // background refresh probes for is not on disk → downloads.
      exists: vi.fn(async (p: string) => p === "app/databases/app.42.db"),
    })
    const { factory, probe } = buildResolveOptions(store, {
      databases: [{ version: 50, scheme: 7 }],
    })
    const runUserDatabaseMigrations = vi.fn(async () => undefined)
    const onBackgroundRefreshComplete = vi.fn()

    const controller = createBootstrapController<TestConfig, { path: string }>({
      supportedScheme: 7,
      buildResolveOptions: factory,
      openContentDatabase: vi.fn(async (p: string) => ({ path: p })),
      closeContentDatabase: vi.fn(async () => undefined),
      readContentSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase: vi.fn(async () => undefined),
      runUserDatabaseMigrations,
      onBackgroundRefreshComplete,
    })

    await controller.start()

    // Entered immediately from cache, no welcome download happened.
    expect(controller.phase.value).toBe("ready")
    expect(controller.startedFromCache.value).toBe(true)
    expect(controller.database.value).toEqual({ path: "app/databases/app.42.db" })
    expect(runUserDatabaseMigrations).toHaveBeenCalledOnce()

    // Foreground never probed; background refresh did.
    await flush()
    expect(probe).toHaveBeenCalledOnce()
    expect(store.download).toHaveBeenCalledWith(
      "https://cdn/remote/app.50.db",
      "app/databases/app.50.db",
      undefined
    )
    expect(onBackgroundRefreshComplete).toHaveBeenCalledWith(true)
  })

  it("no local DB → foreground download with progress, then ready", async () => {
    const downloadCalls: Array<[string, string]> = []
    // Captures the reactive `progress` as the download reports bytes, so we can
    // assert it's exposed as a 0–1 fraction (what the determinate bar binds to).
    const progressSamples: number[] = []
    const store = makeStore({
      list: vi.fn(async () => []),
      exists: vi.fn(async () => false),
      download: vi.fn(async (url: string, path: string, onProgress) => {
        downloadCalls.push([url, path])
        onProgress?.(50, 100)
        progressSamples.push(controller.progress.value)
        onProgress?.(100, 100)
        progressSamples.push(controller.progress.value)
      }),
    })
    const { factory } = buildResolveOptions(store, { databases: [{ version: 9, scheme: 7 }] })
    const runUserDatabaseMigrations = vi.fn(async () => undefined)

    const controller = createBootstrapController<TestConfig, { path: string }>({
      supportedScheme: 7,
      buildResolveOptions: factory,
      openContentDatabase: vi.fn(async (p: string) => ({ path: p })),
      closeContentDatabase: vi.fn(async () => undefined),
      readContentSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase: vi.fn(async () => undefined),
      runUserDatabaseMigrations,
    })

    await controller.start()

    expect(controller.startedFromCache.value).toBe(false)
    expect(controller.phase.value).toBe("ready")
    // Progress is a normalised 0–1 fraction (50/100 → 0.5, 100/100 → 1).
    expect(progressSamples).toEqual([0.5, 1])
    expect(controller.progress.value).toBe(1)
    expect(downloadCalls).toEqual([["https://cdn/remote/app.9.db", "app/databases/app.9.db"]])
    expect(controller.database.value).toEqual({ path: "app/databases/app.9.db" })
    expect(runUserDatabaseMigrations).toHaveBeenCalledOnce()
  })

  it("local present but incompatible scheme → falls back to foreground download", async () => {
    // `list` keeps returning the bad file even after delete (models an adapter
    // where delete is a no-op); the seeded reject set must still skip it.
    const store = makeStore({
      list: vi.fn(async () => ["app.42.db"]),
      exists: vi.fn(async (p: string) => p === "app/databases/app.42.db"),
    })
    const { factory } = buildResolveOptions(store, { databases: [{ version: 50, scheme: 7 }] })
    // cached scheme 6 (bad) on first open; downloaded version reads 7.
    const schemes = [6, 7]
    let call = 0

    const controller = createBootstrapController<TestConfig, { path: string }>({
      supportedScheme: 7,
      buildResolveOptions: factory,
      openContentDatabase: vi.fn(async (p: string) => ({ path: p })),
      closeContentDatabase: vi.fn(async () => undefined),
      readContentSchemeVersion: vi.fn(async () => schemes[call++]),
      deleteLocalDatabase: vi.fn(async () => undefined),
      invalidateConfigCache: vi.fn(async () => undefined),
      runUserDatabaseMigrations: vi.fn(async () => undefined),
    })

    await controller.start()
    await flush()

    expect(controller.startedFromCache.value).toBe(false)
    expect(controller.phase.value).toBe("ready")
    expect(controller.database.value).toEqual({ path: "app/databases/app.50.db" })
  })

  it("foreground failure → error phase, retry re-runs", async () => {
    const probe = vi.fn(async () => {
      throw new Error("All servers are unreachable")
    })
    const store = makeStore({ list: vi.fn(async () => []) })
    const factory = (
      incompatibleDbPaths: ReadonlySet<string>
    ): ResolveContentDatabaseOptions<TestConfig> => ({
      store,
      probe: probe as never,
      configPath: "public/config.json",
      remotePathTemplate: "remote/app.{version}.db",
      localPathTemplate: TEMPLATE,
      supportedScheme: 7,
      incompatibleDbPaths,
    })
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    const controller = createBootstrapController<TestConfig, { path: string }>({
      supportedScheme: 7,
      buildResolveOptions: factory,
      openContentDatabase: vi.fn(async (p: string) => ({ path: p })),
      closeContentDatabase: vi.fn(async () => undefined),
      readContentSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase: vi.fn(async () => undefined),
      runUserDatabaseMigrations: vi.fn(async () => undefined),
    })

    await controller.start()
    expect(controller.phase.value).toBe("error")
    expect(controller.isError.value).toBe(true)
    expect(controller.error.value).toMatch(/unreachable/)

    // Retry still fails the same way (deterministic), but exercises the path.
    await controller.retry()
    expect(controller.phase.value).toBe("error")
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("background refresh error is swallowed (does not affect ready)", async () => {
    const store = makeStore({
      list: vi.fn(async () => ["app.42.db"]),
      exists: vi.fn(async (p: string) => p === "app/databases/app.42.db"),
    })
    const probe = vi.fn(async () => {
      throw new Error("offline")
    })
    const factory = (
      incompatibleDbPaths: ReadonlySet<string>
    ): ResolveContentDatabaseOptions<TestConfig> => ({
      store,
      probe: probe as never,
      configPath: "public/config.json",
      remotePathTemplate: "remote/app.{version}.db",
      localPathTemplate: TEMPLATE,
      supportedScheme: 7,
      incompatibleDbPaths,
    })
    const onBackgroundRefreshError = vi.fn()

    const controller = createBootstrapController<TestConfig, { path: string }>({
      supportedScheme: 7,
      buildResolveOptions: factory,
      openContentDatabase: vi.fn(async (p: string) => ({ path: p })),
      closeContentDatabase: vi.fn(async () => undefined),
      readContentSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase: vi.fn(async () => undefined),
      runUserDatabaseMigrations: vi.fn(async () => undefined),
      onBackgroundRefreshError,
    })

    await controller.start()
    expect(controller.phase.value).toBe("ready")
    await flush()
    expect(onBackgroundRefreshError).toHaveBeenCalledOnce()
    expect(controller.phase.value).toBe("ready")
  })
})

describe("createBootstrapController — cached-file integrity gate", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("cached file fails the store's integrity check → dropped, resolver takes over", async () => {
    // `list` still reports the truncated file (delete is a no-op here), so only
    // the seeded reject set keeps the resolver from picking it up again.
    const store = makeStore({
      list: vi.fn(async () => ["app.42.db"]),
      exists: vi.fn(async () => false),
    })
    const { factory } = buildResolveOptions(store, { databases: [{ version: 50, scheme: 7 }] })
    const openContentDatabase = vi.fn(async (p: string) => ({ path: p }))
    const deleteLocalDatabase = vi.fn(async () => undefined)

    const controller = createBootstrapController<TestConfig, { path: string }>({
      supportedScheme: 7,
      buildResolveOptions: factory,
      openContentDatabase,
      closeContentDatabase: vi.fn(async () => undefined),
      readContentSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase,
      runUserDatabaseMigrations: vi.fn(async () => undefined),
    })

    await controller.start()
    await flush()

    expect(openContentDatabase).not.toHaveBeenCalledWith("app/databases/app.42.db")
    expect(deleteLocalDatabase).toHaveBeenCalledWith("app/databases/app.42.db")
    expect(controller.phase.value).toBe("ready")
    expect(controller.startedFromCache.value).toBe(false)
    expect(controller.database.value).toEqual({ path: "app/databases/app.50.db" })
  })

  it("cached file passes the gate but keeps failing to open → dropped, no error phase", async () => {
    const store = makeStore({
      list: vi.fn(async () => ["app.42.db"]),
      exists: vi.fn(async (p: string) => p === "app/databases/app.42.db"),
    })
    const { factory } = buildResolveOptions(store, { databases: [{ version: 50, scheme: 7 }] })
    const openContentDatabase = vi.fn(async (p: string) => {
      if (p === "app/databases/app.42.db") throw new Error("file is not a database")
      return { path: p }
    })
    const closeContentDatabase = vi.fn(async () => undefined)
    const deleteLocalDatabase = vi.fn(async () => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const controller = createBootstrapController<TestConfig, { path: string }>({
      supportedScheme: 7,
      buildResolveOptions: factory,
      openContentDatabase,
      closeContentDatabase,
      readContentSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase,
      runUserDatabaseMigrations: vi.fn(async () => undefined),
    })

    await controller.start()
    await flush()

    // One failed open is not evidence of a bad file: the drop is the validate
    // loop's call, after the resolver picked the same file and it failed again.
    const attempts = openContentDatabase.mock.calls.filter(([p]) => p === "app/databases/app.42.db")
    expect(attempts).toHaveLength(2)
    expect(closeContentDatabase).toHaveBeenCalled()
    expect(deleteLocalDatabase).toHaveBeenCalledExactlyOnceWith("app/databases/app.42.db")
    expect(controller.phase.value).toBe("ready")
    expect(controller.database.value).toEqual({ path: "app/databases/app.50.db" })
  })

  it("a one-off open failure leaves the cached file in place and reuses it (#29)", async () => {
    const store = makeStore({
      list: vi.fn(async () => ["app.42.db"]),
      exists: vi.fn(async (p: string) => p === "app/databases/app.42.db"),
    })
    const { factory, probe } = buildResolveOptions(store, {
      databases: [{ version: 50, scheme: 7 }],
    })
    // The "connection already exists" class of failure: the retry succeeds.
    let firstOpen = true
    const openContentDatabase = vi.fn(async (p: string) => {
      if (firstOpen) {
        firstOpen = false
        throw new Error("connection already exists")
      }
      return { path: p }
    })
    const deleteLocalDatabase = vi.fn(async () => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const controller = createBootstrapController<TestConfig, { path: string }>({
      supportedScheme: 7,
      buildResolveOptions: factory,
      openContentDatabase,
      closeContentDatabase: vi.fn(async () => undefined),
      readContentSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase,
      runUserDatabaseMigrations: vi.fn(async () => undefined),
    })

    await controller.start()
    await flush()

    expect(deleteLocalDatabase).not.toHaveBeenCalled()
    expect(store.delete).not.toHaveBeenCalledWith("app/databases/app.42.db")
    // The path stays eligible, so the resolver reuses it offline instead of
    // reaching for the CDN.
    expect(controller.phase.value).toBe("ready")
    expect(controller.database.value).toEqual({ path: "app/databases/app.42.db" })
    expect(store.download).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })
})

describe("createBootstrapController — pruning superseded databases", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("drops every version below the one opened from cache, and nothing else", async () => {
    const store = makeStore({
      list: vi.fn(async () => ["app.7.db", "app.41.db", "app.42.db", "user.db", "app.42.db.tmp"]),
      exists: vi.fn(async (p: string) => p === "app/databases/app.42.db"),
    })
    const { factory } = buildResolveOptions(store, { databases: [{ version: 42, scheme: 7 }] })
    const onPrune = vi.fn()

    const controller = createBootstrapController<TestConfig, { path: string }>({
      supportedScheme: 7,
      buildResolveOptions: factory,
      openContentDatabase: vi.fn(async (p: string) => ({ path: p })),
      closeContentDatabase: vi.fn(async () => undefined),
      readContentSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase: vi.fn(async () => undefined),
      runUserDatabaseMigrations: vi.fn(async () => undefined),
      onPrune,
    })

    await controller.start()
    await flush()

    expect(controller.startedFromCache.value).toBe(true)
    expect(store.delete).toHaveBeenCalledWith("app/databases/app.7.db")
    expect(store.delete).toHaveBeenCalledWith("app/databases/app.41.db")
    expect(store.delete).toHaveBeenCalledTimes(2)
    expect(onPrune).toHaveBeenCalledWith(["app/databases/app.7.db", "app/databases/app.41.db"])
  })

  it("prunes after a foreground download too", async () => {
    const store = makeStore({
      list: vi.fn(async () => ["app.9.db"]),
      exists: vi.fn(async () => false),
    })
    const { factory } = buildResolveOptions(store, { databases: [{ version: 50, scheme: 7 }] })

    const controller = createBootstrapController<TestConfig, { path: string }>({
      supportedScheme: 7,
      buildResolveOptions: factory,
      openContentDatabase: vi.fn(async (p: string) => ({ path: p })),
      closeContentDatabase: vi.fn(async () => undefined),
      readContentSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase: vi.fn(async () => undefined),
      runUserDatabaseMigrations: vi.fn(async () => undefined),
    })

    await controller.start()
    await flush()

    expect(controller.phase.value).toBe("ready")
    expect(store.delete).toHaveBeenCalledWith("app/databases/app.9.db")
  })
})
