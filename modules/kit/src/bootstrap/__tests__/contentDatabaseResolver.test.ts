import { describe, it, expect, vi } from "vitest"
import {
  resolveContentDatabase,
  downloadFromCdn,
  findLatestCompatibleVersion,
  findLocalDatabaseVersion,
  pruneContentDatabases,
  deriveParentDir,
  buildVersionedPath,
  type ContentDatabaseStore,
  type ProbeResult,
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

describe("helpers", () => {
  it("derives the parent directory of a versioned template", () => {
    expect(deriveParentDir("app/databases/app.{version}.db")).toBe("app/databases")
    expect(deriveParentDir("app/databases/{version}.db")).toBe("app/databases")
    expect(deriveParentDir("app.{version}.db")).toBe("")
  })

  it("substitutes the {version} placeholder", () => {
    expect(buildVersionedPath(TEMPLATE, 42)).toBe("app/databases/app.42.db")
  })

  it("picks the latest compatible remote version", () => {
    const cfg: TestConfig = {
      databases: [
        { version: 1, scheme: 7 },
        { version: 3, scheme: 7 },
        { version: 9, scheme: 8 },
      ],
    }
    expect(findLatestCompatibleVersion(cfg, 7)).toBe(3)
    expect(findLatestCompatibleVersion(cfg, 8)).toBe(9)
    expect(findLatestCompatibleVersion(cfg, 99)).toBeNull()
  })

  it("treats a missing scheme as scheme 1", () => {
    expect(findLatestCompatibleVersion({ databases: [{ version: 5 }] }, 1)).toBe(5)
  })

  it("finds the latest local version from filenames, skipping rejects", () => {
    const files = ["app.10.db", "app.20.db", "app.15.db", "other.99.db"]
    expect(findLocalDatabaseVersion(files, "app/databases", TEMPLATE, new Set())).toBe(20)
    expect(
      findLocalDatabaseVersion(
        files,
        "app/databases",
        TEMPLATE,
        new Set(["app/databases/app.20.db"])
      )
    ).toBe(15)
  })

  it("returns null when no local file matches", () => {
    expect(findLocalDatabaseVersion(["nope.db"], "d", TEMPLATE, new Set())).toBeNull()
    expect(findLocalDatabaseVersion([], "d", TEMPLATE, new Set())).toBeNull()
  })

  it("matches files returned as full paths too", () => {
    const files = ["app/databases/app.30.db"]
    expect(findLocalDatabaseVersion(files, "app/databases", TEMPLATE, new Set())).toBe(30)
  })
})

describe("resolveContentDatabase — offline first", () => {
  it("returns the cached version without probing when a local DB exists", async () => {
    const store = makeStore({
      list: vi.fn(async () => ["app.42.db"]),
      exists: vi.fn(async () => true),
    })
    const probe = vi.fn()
    const result = await resolveContentDatabase<TestConfig>({
      store,
      probe,
      configPath: "public/config.json",
      remotePathTemplate: "remote/app.{version}.db",
      localPathTemplate: TEMPLATE,
      supportedScheme: 7,
    })
    expect(result).toEqual({
      localPath: "app/databases/app.42.db",
      version: 42,
      fromCache: true,
    })
    expect(probe).not.toHaveBeenCalled()
    expect(store.download).not.toHaveBeenCalled()
  })

  it("validates the cached file via exists() before accepting it", async () => {
    const exists = vi.fn(async () => true)
    const store = makeStore({ list: vi.fn(async () => ["app.42.db"]), exists })
    const result = await resolveContentDatabase<TestConfig>({
      store,
      probe: vi.fn(),
      configPath: "public/config.json",
      remotePathTemplate: "remote/app.{version}.db",
      localPathTemplate: TEMPLATE,
      supportedScheme: 7,
    })
    expect(exists).toHaveBeenCalledWith("app/databases/app.42.db")
    expect(result.fromCache).toBe(true)
  })

  it("rejects a corrupt cached file and re-downloads from the CDN", async () => {
    // The newest cached file is present (list sees it) but corrupt: exists()
    // — the adapter's integrity-checking read — returns false.
    const exists = vi.fn(async () => false)
    const del = vi.fn(async () => undefined)
    const store = makeStore({
      list: vi.fn(async () => ["app.42.db"]),
      exists,
      delete: del,
    })
    const probe = vi.fn(
      async (): Promise<ProbeResult<TestConfig>> => ({
        server: { id: "s1", urlTemplate: "https://cdn/{path}" },
        config: { databases: [{ version: 50, scheme: 7 }] },
      })
    )
    const result = await resolveContentDatabase<TestConfig>({
      store,
      probe,
      configPath: "public/config.json",
      remotePathTemplate: "remote/app.{version}.db",
      localPathTemplate: TEMPLATE,
      supportedScheme: 7,
    })
    expect(exists).toHaveBeenCalledWith("app/databases/app.42.db")
    // The corrupt cached file is dropped so it can't be reconsidered or waste disk.
    expect(del).toHaveBeenCalledWith("app/databases/app.42.db")
    expect(probe).toHaveBeenCalledOnce()
    expect(store.download).toHaveBeenCalledOnce()
    expect(result.version).toBe(50)
    expect(result.fromCache).toBe(false)
  })

  it("falls back to an older valid cache when the newest is corrupt", async () => {
    // 42 is corrupt, 30 is valid: the resolver should land on 30 from cache and
    // never touch the network.
    const exists = vi.fn(async (path: string) => path === "app/databases/app.30.db")
    const store = makeStore({
      list: vi.fn(async () => ["app.30.db", "app.42.db"]),
      exists,
    })
    const probe = vi.fn()
    const result = await resolveContentDatabase<TestConfig>({
      store,
      probe,
      configPath: "public/config.json",
      remotePathTemplate: "remote/app.{version}.db",
      localPathTemplate: TEMPLATE,
      supportedScheme: 7,
    })
    expect(probe).not.toHaveBeenCalled()
    expect(store.download).not.toHaveBeenCalled()
    expect(result).toEqual({
      localPath: "app/databases/app.30.db",
      version: 30,
      fromCache: true,
    })
  })

  it("skips a rejected cached path and falls through to the CDN", async () => {
    const store = makeStore({ list: vi.fn(async () => ["app.42.db"]) })
    const probe = vi.fn(
      async (): Promise<ProbeResult<TestConfig>> => ({
        server: { id: "s1", urlTemplate: "https://cdn/{path}" },
        config: { databases: [{ version: 50, scheme: 7 }] },
      })
    )
    const result = await resolveContentDatabase<TestConfig>({
      store,
      probe,
      configPath: "public/config.json",
      remotePathTemplate: "remote/app.{version}.db",
      localPathTemplate: TEMPLATE,
      supportedScheme: 7,
      incompatibleDbPaths: new Set(["app/databases/app.42.db"]),
    })
    expect(probe).toHaveBeenCalledOnce()
    expect(result.version).toBe(50)
    expect(result.fromCache).toBe(false)
  })
})

describe("downloadFromCdn", () => {
  it("probes, picks latest compatible, and downloads when absent", async () => {
    const store = makeStore({ exists: vi.fn(async () => false) })
    const onServerResolved = vi.fn()
    const onConfigResolved = vi.fn()
    const phases: string[] = []
    const probe = vi.fn(
      async (): Promise<ProbeResult<TestConfig>> => ({
        server: { id: "s1", urlTemplate: "https://cdn/{path}" },
        config: { databases: [{ version: 100, scheme: 7 }] },
      })
    )

    const result = await downloadFromCdn<TestConfig>({
      store,
      probe,
      configPath: "public/config.json",
      remotePathTemplate: "remote/app.{version}.db",
      localPathTemplate: TEMPLATE,
      supportedScheme: 7,
      preferredServerId: "s1",
      onServerResolved,
      onConfigResolved,
      onPhase: (p) => phases.push(p),
    })

    expect(probe).toHaveBeenCalledWith("public/config.json", "s1")
    expect(onServerResolved).toHaveBeenCalledOnce()
    expect(onConfigResolved).toHaveBeenCalledWith({ databases: [{ version: 100, scheme: 7 }] })
    expect(store.download).toHaveBeenCalledWith(
      "https://cdn/remote/app.100.db",
      "app/databases/app.100.db",
      undefined
    )
    expect(result).toEqual({
      localPath: "app/databases/app.100.db",
      version: 100,
      fromCache: false,
    })
    expect(phases).toContain("database:downloading")
  })

  it("does not download when the target version already exists on disk", async () => {
    const store = makeStore({ exists: vi.fn(async () => true) })
    const probe = vi.fn(
      async (): Promise<ProbeResult<TestConfig>> => ({
        server: { id: "s1", urlTemplate: "https://cdn/{path}" },
        config: { databases: [{ version: 100, scheme: 7 }] },
      })
    )
    const result = await downloadFromCdn<TestConfig>({
      store,
      probe,
      configPath: "public/config.json",
      remotePathTemplate: "remote/app.{version}.db",
      localPathTemplate: TEMPLATE,
      supportedScheme: 7,
    })
    expect(store.download).not.toHaveBeenCalled()
    expect(result.fromCache).toBe(false)
  })

  it("throws when no compatible version is advertised", async () => {
    const probe = vi.fn(
      async (): Promise<ProbeResult<TestConfig>> => ({
        server: { id: "s1", urlTemplate: "https://cdn/{path}" },
        config: { databases: [{ version: 1, scheme: 999 }] },
      })
    )
    await expect(
      downloadFromCdn<TestConfig>({
        store: makeStore(),
        probe,
        configPath: "public/config.json",
        remotePathTemplate: "remote/app.{version}.db",
        localPathTemplate: TEMPLATE,
        supportedScheme: 7,
      })
    ).rejects.toThrow(/No compatible content database for scheme 7/)
  })
})

describe("pruneContentDatabases", () => {
  it("deletes only versions below the kept one", async () => {
    const store = makeStore({
      list: vi.fn(async () => ["app.7.db", "app.41.db", "app.42.db", "app.50.db"]),
    })
    const deleted = await pruneContentDatabases(store, TEMPLATE, 42)
    expect(deleted).toEqual(["app/databases/app.7.db", "app/databases/app.41.db"])
    expect(store.delete).toHaveBeenCalledTimes(2)
  })

  it("keeps siblings that aren't versioned content DBs", async () => {
    const store = makeStore({
      list: vi.fn(async () => ["user.db", "app.7.db", "app.42.db.download", "notes.json"]),
    })
    const deleted = await pruneContentDatabases(store, TEMPLATE, null)
    expect(deleted).toEqual(["app/databases/app.7.db"])
  })

  it("keepVersion null wipes every content DB", async () => {
    const store = makeStore({
      list: vi.fn(async () => ["app.7.db", "app.42.db"]),
    })
    const deleted = await pruneContentDatabases(store, TEMPLATE, null)
    expect(deleted).toEqual(["app/databases/app.7.db", "app/databases/app.42.db"])
  })

  it("survives a failing delete and an unlistable directory", async () => {
    const failing = makeStore({
      list: vi.fn(async () => ["app.7.db", "app.8.db"]),
      delete: vi.fn(async (p: string) => {
        if (p === "app/databases/app.7.db") throw new Error("locked")
      }),
    })
    expect(await pruneContentDatabases(failing, TEMPLATE, null)).toEqual(["app/databases/app.8.db"])

    const unlistable = makeStore({
      list: vi.fn(async () => {
        throw new Error("no such directory")
      }),
    })
    expect(await pruneContentDatabases(unlistable, TEMPLATE, null)).toEqual([])
  })
})
