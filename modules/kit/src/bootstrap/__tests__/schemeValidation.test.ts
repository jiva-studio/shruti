import { describe, it, expect, vi } from "vitest"
import { openAndValidateContentDatabase, isSchemeCompatible } from "../schemeValidation.js"
import type {
  ContentDatabaseStore,
  ResolveContentDatabaseOptions,
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

describe("isSchemeCompatible", () => {
  it("accepts an exact match and the legacy 0", () => {
    expect(isSchemeCompatible(7, 7)).toBe(true)
    expect(isSchemeCompatible(0, 7)).toBe(true)
  })
  it("rejects a mismatch", () => {
    expect(isSchemeCompatible(6, 7)).toBe(false)
  })
})

function buildResolveOptions(
  store: ContentDatabaseStore,
  config: TestConfig
): (s: ReadonlySet<string>) => ResolveContentDatabaseOptions<TestConfig> {
  return (incompatibleDbPaths) => ({
    store,
    probe: async () => ({
      server: { id: "s1", urlTemplate: "https://cdn/{path}" },
      config,
    }),
    configPath: "public/config.json",
    remotePathTemplate: "remote/app.{version}.db",
    localPathTemplate: TEMPLATE,
    supportedScheme: 7,
    incompatibleDbPaths,
  })
}

describe("openAndValidateContentDatabase", () => {
  it("opens + returns the DB when the scheme matches", async () => {
    const store = makeStore({ list: vi.fn(async () => ["app.10.db"]) })
    const openDatabase = vi.fn(async (p: string) => ({ path: p }))
    const res = await openAndValidateContentDatabase({
      buildResolveOptions: buildResolveOptions(store, { databases: [{ version: 10, scheme: 7 }] }),
      supportedScheme: 7,
      openDatabase,
      closeDatabase: vi.fn(async () => undefined),
      readSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase: vi.fn(async () => undefined),
    })
    expect(res.scheme).toBe(7)
    expect(res.result.localPath).toBe("app/databases/app.10.db")
    expect(openDatabase).toHaveBeenCalledOnce()
  })

  it("rejects a bad cached scheme, deletes it, re-downloads a good one", async () => {
    // First: a bad cached file (scheme 6). After delete+reject, re-resolve
    // hits the CDN (list still returns the bad name, but it's now rejected),
    // downloads version 20 (scheme 7).
    const store = makeStore({
      list: vi.fn(async () => ["app.10.db"]),
      exists: vi.fn(async () => false),
    })
    const schemes = [6, 7]
    let call = 0
    const res = await openAndValidateContentDatabase({
      buildResolveOptions: buildResolveOptions(store, { databases: [{ version: 20, scheme: 7 }] }),
      supportedScheme: 7,
      openDatabase: vi.fn(async (p: string) => ({ path: p })),
      closeDatabase: vi.fn(async () => undefined),
      readSchemeVersion: vi.fn(async () => schemes[call++]),
      deleteLocalDatabase: vi.fn(async () => undefined),
      invalidateConfigCache: vi.fn(async () => undefined),
    })
    expect(res.scheme).toBe(7)
    expect(res.result.version).toBe(20)
  })

  it("recovers when opening a structurally-corrupt DB throws (no hard abort)", async () => {
    // The file passed the cheap header gate but is corrupt, so openDatabase
    // throws. That must be treated like a scheme mismatch (delete + reject +
    // re-resolve), NOT escape and abort bootstrap.
    const store = makeStore({
      list: vi.fn(async () => ["app.10.db"]),
      exists: vi.fn(async () => false),
    })
    let attempt = 0
    const openDatabase = vi.fn(async (p: string) => {
      if (attempt++ === 0) throw new Error("file is not a database")
      return { path: p }
    })
    const deleteLocalDatabase = vi.fn(async () => undefined)
    const res = await openAndValidateContentDatabase({
      buildResolveOptions: buildResolveOptions(store, { databases: [{ version: 20, scheme: 7 }] }),
      supportedScheme: 7,
      openDatabase,
      closeDatabase: vi.fn(async () => undefined),
      readSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase,
      invalidateConfigCache: vi.fn(async () => undefined),
    })
    expect(openDatabase).toHaveBeenCalledTimes(2)
    expect(deleteLocalDatabase).toHaveBeenCalledOnce()
    expect(res.scheme).toBe(7)
    expect(res.result.version).toBe(20)
  })

  it("recovers when readSchemeVersion throws on a corrupt open DB", async () => {
    const store = makeStore({
      list: vi.fn(async () => []),
      exists: vi.fn(async () => false),
    })
    let attempt = 0
    const readSchemeVersion = vi.fn(async () => {
      if (attempt++ === 0) throw new Error("Content database is unreadable")
      return 7
    })
    const res = await openAndValidateContentDatabase({
      buildResolveOptions: buildResolveOptions(store, { databases: [{ version: 20, scheme: 7 }] }),
      supportedScheme: 7,
      openDatabase: vi.fn(async (p: string) => ({ path: p })),
      closeDatabase: vi.fn(async () => undefined),
      readSchemeVersion,
      deleteLocalDatabase: vi.fn(async () => undefined),
      invalidateConfigCache: vi.fn(async () => undefined),
    })
    expect(readSchemeVersion).toHaveBeenCalledTimes(2)
    expect(res.scheme).toBe(7)
  })

  it("drops a stale cached config + re-probes when it lists no compatible version", async () => {
    // A stale cached config (no compatible db) makes resolve throw before any
    // DB is opened. The loop must invalidate the config cache and re-probe; the
    // fresh config now carries a compatible version and startup recovers.
    const store = makeStore({ list: vi.fn(async () => []) })
    let configRefreshed = false
    const invalidateConfigCache = vi.fn(async () => {
      configRefreshed = true
    })
    const res = await openAndValidateContentDatabase({
      buildResolveOptions: (incompatibleDbPaths) => ({
        store,
        probe: async () => ({
          server: { id: "s1", urlTemplate: "https://cdn/{path}" },
          // stale config: nothing for scheme 7; fresh config: version 20.
          config: configRefreshed
            ? { databases: [{ version: 20, scheme: 7 }] }
            : { databases: [{ version: 5, scheme: 6 }] },
        }),
        configPath: "public/config.json",
        remotePathTemplate: "remote/app.{version}.db",
        localPathTemplate: TEMPLATE,
        supportedScheme: 7,
        incompatibleDbPaths,
      }),
      supportedScheme: 7,
      openDatabase: vi.fn(async (p: string) => ({ path: p })),
      closeDatabase: vi.fn(async () => undefined),
      readSchemeVersion: vi.fn(async () => 7),
      deleteLocalDatabase: vi.fn(async () => undefined),
      invalidateConfigCache,
    })
    expect(invalidateConfigCache).toHaveBeenCalledOnce()
    expect(res.result.version).toBe(20)
    expect(res.scheme).toBe(7)
  })

  it("rethrows NoCompatibleDatabaseError when the fresh config also has nothing", async () => {
    const store = makeStore({ list: vi.fn(async () => []) })
    await expect(
      openAndValidateContentDatabase({
        buildResolveOptions: buildResolveOptions(store, { databases: [{ version: 5, scheme: 6 }] }),
        supportedScheme: 7,
        openDatabase: vi.fn(async (p: string) => ({ path: p })),
        closeDatabase: vi.fn(async () => undefined),
        readSchemeVersion: vi.fn(async () => 7),
        deleteLocalDatabase: vi.fn(async () => undefined),
        invalidateConfigCache: vi.fn(async () => undefined),
      })
    ).rejects.toThrow(/No compatible content database for scheme 7/)
  })

  it("throws after maxRetries scheme mismatches", async () => {
    const store = makeStore({ list: vi.fn(async () => []) })
    await expect(
      openAndValidateContentDatabase({
        buildResolveOptions: buildResolveOptions(store, { databases: [{ version: 5, scheme: 7 }] }),
        supportedScheme: 7,
        openDatabase: vi.fn(async (p: string) => ({ path: p })),
        closeDatabase: vi.fn(async () => undefined),
        readSchemeVersion: vi.fn(async () => 6),
        deleteLocalDatabase: vi.fn(async () => undefined),
        maxRetries: 2,
      })
    ).rejects.toThrow(/scheme validation failed after 2 attempts.*got: 6, 6/s)
  })
})
