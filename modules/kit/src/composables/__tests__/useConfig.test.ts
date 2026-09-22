import { describe, it, expect, vi } from "vitest"
import { nextTick } from "vue"
import { createUseConfig, type PreferencesPort } from "../index.js"

function fakePreferences(seed: Record<string, string> = {}): PreferencesPort & {
  store: Record<string, string>
} {
  const store: Record<string, string> = { ...seed }
  return {
    store,
    get: vi.fn(async (key: string) => (key in store ? store[key] : null)),
    set: vi.fn(async (key: string, value: string) => {
      store[key] = value
    }),
  }
}

type DeferredWrite = {
  key: string
  value: string
  settle: () => void
  fail: (reason?: unknown) => void
}

/** Preferences whose `set` stays in flight until the test settles it by hand. */
function deferredPreferences(seed: Record<string, string> = {}): PreferencesPort & {
  store: Record<string, string>
  writes: DeferredWrite[]
} {
  const store: Record<string, string> = { ...seed }
  const writes: DeferredWrite[] = []
  return {
    store,
    writes,
    get: vi.fn(async (key: string) => (key in store ? store[key] : null)),
    set: vi.fn(
      (key: string, value: string) =>
        new Promise<void>((resolve, reject) => {
          writes.push({
            key,
            value,
            settle: () => {
              store[key] = value
              resolve()
            },
            fail: (reason) => reject(reason ?? new Error("write failed")),
          })
        })
    ),
  }
}

// Let queued microtasks (async hydrate + persist) settle.
const flush = async () => {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
}

/** Settle every write the composable issues, including trailing ones. */
const drain = async (prefs: ReturnType<typeof deferredPreferences>) => {
  for (let i = 0; i < prefs.writes.length; i++) {
    prefs.writes[i].settle()
    await flush()
  }
}

describe("createUseConfig", () => {
  it("returns the initial value before hydration completes", () => {
    const prefs = fakePreferences()
    const useConfig = createUseConfig(prefs)
    const v = useConfig("flag", false)
    expect(v.value).toBe(false)
  })

  it("hydrates from storage on first access", async () => {
    const prefs = fakePreferences({ "settings.lang": JSON.stringify("ru") })
    const useConfig = createUseConfig(prefs)
    const lang = useConfig("settings.lang", "en")
    await flush()
    expect(lang.value).toBe("ru")
  })

  it("persists writes (JSON-serialized) after hydration", async () => {
    const prefs = fakePreferences()
    const useConfig = createUseConfig(prefs)
    const count = useConfig("count", 0)
    await flush()
    count.value = 5
    await flush()
    expect(prefs.store.count).toBe("5")
    expect(prefs.set).toHaveBeenCalledWith("count", "5")
  })

  it("does not persist the initial value during hydration", async () => {
    const prefs = fakePreferences()
    const useConfig = createUseConfig(prefs)
    useConfig("a", "x")
    await flush()
    expect(prefs.set).not.toHaveBeenCalled()
  })

  it("shares one ref per key within a factory (live cross-consumer updates)", async () => {
    const prefs = fakePreferences()
    const useConfig = createUseConfig(prefs)
    const a = useConfig("shared", 1)
    const b = useConfig("shared", 999)
    await flush()
    expect(b).toBe(a)
    a.value = 7
    expect(b.value).toBe(7)
  })

  it("isolates caches between factory instances", () => {
    const f1 = createUseConfig(fakePreferences())
    const f2 = createUseConfig(fakePreferences())
    expect(f1("k", 1)).not.toBe(f2("k", 1))
  })

  it("keeps the initial value when the stored payload is corrupt", async () => {
    const prefs = fakePreferences({ broken: "{not json" })
    const useConfig = createUseConfig(prefs)
    const v = useConfig("broken", "fallback")
    await flush()
    expect(v.value).toBe("fallback")
  })

  it("round-trips arrays and objects through the default serializer", async () => {
    const prefs = fakePreferences()
    const useConfig = createUseConfig(prefs)
    const list = useConfig<string[]>("list", [])
    await flush()
    list.value = ["a", "b"]
    await flush()
    expect(prefs.store.list).toBe(JSON.stringify(["a", "b"]))

    const reader = createUseConfig(fakePreferences({ list: prefs.store.list }))
    const restored = reader<string[]>("list", [])
    await flush()
    expect(restored.value).toEqual(["a", "b"])
  })

  it("honours a custom serializer", async () => {
    const prefs = fakePreferences({ raw: "hello" })
    const useConfig = createUseConfig(prefs)
    const v = useConfig("raw", "", { encode: (s) => s, decode: (s) => s })
    await flush()
    expect(v.value).toBe("hello")
    v.value = "world"
    await flush()
    expect(prefs.store.raw).toBe("world")
  })

  describe("writes that overlap an in-flight set", () => {
    it("persists a change that lands while a write is in flight", async () => {
      const prefs = deferredPreferences()
      const v = createUseConfig(prefs)("k", 0)
      await flush()

      v.value = 1
      await flush()
      expect(prefs.writes).toHaveLength(1)

      // Lands while write #1 is still unresolved — must not be dropped.
      v.value = 2
      await flush()
      expect(prefs.writes).toHaveLength(1)

      await drain(prefs)
      expect(prefs.writes.at(-1)!.value).toBe("2")
      expect(prefs.store.k).toBe("2")
    })

    it("ends a burst with the LAST value in storage", async () => {
      const prefs = deferredPreferences()
      const v = createUseConfig(prefs)("burst", 0)
      await flush()

      for (let i = 1; i <= 6; i++) {
        v.value = i
        await flush()
      }

      await drain(prefs)
      expect(prefs.store.burst).toBe("6")
    })

    it("collapses a burst instead of issuing one write per change", async () => {
      const prefs = deferredPreferences()
      const v = createUseConfig(prefs)("burst", 0)
      await flush()

      for (let i = 1; i <= 6; i++) {
        v.value = i
        await flush()
      }

      // At most one in-flight write plus one coalesced trailing write.
      expect(prefs.writes.length).toBeLessThanOrEqual(2)
      await drain(prefs)
      expect(prefs.writes.length).toBeLessThanOrEqual(2)
      expect(prefs.store.burst).toBe("6")
    })

    it("does not queue stale intermediate values behind a slow write", async () => {
      const prefs = deferredPreferences()
      const v = createUseConfig(prefs)("slow", 0)
      await flush()

      v.value = 1
      await flush()
      for (const i of [2, 3, 4]) {
        v.value = i
        await flush()
      }

      prefs.writes[0].settle()
      await flush()
      // The trailing write carries the newest value, never 2 or 3.
      expect(prefs.writes).toHaveLength(2)
      expect(prefs.writes[1].value).toBe("4")
    })
  })

  describe("failed writes", () => {
    it("does not wedge the mechanism when a write rejects", async () => {
      const prefs = deferredPreferences()
      const v = createUseConfig(prefs)("k", 0)
      await flush()

      v.value = 1
      await flush()
      prefs.writes[0].fail()
      await flush()

      v.value = 2
      await flush()
      expect(prefs.writes).toHaveLength(2)
      await drain(prefs)
      expect(prefs.store.k).toBe("2")
    })

    it("still flushes a queued value after the in-flight write rejects", async () => {
      const prefs = deferredPreferences()
      const v = createUseConfig(prefs)("k", 0)
      await flush()

      v.value = 1
      await flush()
      v.value = 2
      await flush()

      prefs.writes[0].fail()
      await flush()
      expect(prefs.writes).toHaveLength(2)
      expect(prefs.writes[1].value).toBe("2")

      await drain(prefs)
      expect(prefs.store.k).toBe("2")
    })
  })

  it("lets hydration win over a write issued before it completes", async () => {
    let releaseGet: (raw: string | null) => void = () => {}
    const store: Record<string, string> = {}
    const prefs: PreferencesPort = {
      get: vi.fn(() => new Promise<string | null>((resolve) => (releaseGet = resolve))),
      set: vi.fn(async (key: string, value: string) => {
        store[key] = value
      }),
    }

    const v = createUseConfig(prefs)("lang", "en")
    v.value = "de"
    await flush()
    expect(prefs.set).not.toHaveBeenCalled()

    releaseGet(JSON.stringify("ru"))
    await flush()
    expect(v.value).toBe("ru")
    expect(prefs.set).not.toHaveBeenCalledWith("lang", JSON.stringify("de"))
  })
})
