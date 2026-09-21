import { afterEach, describe, expect, it, vi } from "vitest"
import { pollUntilReady } from "../pollUntilReady.js"

type Probe = () => { ok: boolean } | Promise<{ ok: boolean }>

function stubProbes(probe: Probe): { calls: () => number } {
  let calls = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1
      return probe()
    })
  )
  return { calls: () => calls }
}

const FAST = { intervalMs: 1, probeTimeoutMs: 20 }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("pollUntilReady", () => {
  it("returns on the first probe when the file is already there", async () => {
    const probes = stubProbes(() => ({ ok: true }))

    await expect(pollUntilReady("https://cdn/x.mp3", FAST)).resolves.toBeUndefined()

    expect(probes.calls()).toBe(1)
  })

  it("keeps probing until the render lands", async () => {
    let n = 0
    stubProbes(() => ({ ok: ++n >= 3 }))

    await expect(pollUntilReady("https://cdn/x.mp3", FAST)).resolves.toBeUndefined()
  })

  it("treats a network error as one more miss, not a failure", async () => {
    let n = 0
    stubProbes(() => {
      if (++n < 3) throw new Error("ECONNRESET")
      return { ok: true }
    })

    await expect(pollUntilReady("https://cdn/x.mp3", FAST)).resolves.toBeUndefined()
  })

  it("names the url it gave up on", async () => {
    stubProbes(() => ({ ok: false }))

    await expect(
      pollUntilReady("https://cdn/dead.mp3", { ...FAST, timeoutMs: 30 })
    ).rejects.toThrow(/https:\/\/cdn\/dead\.mp3/)
  })

  it("stops on a timeout rather than probing forever", async () => {
    const probes = stubProbes(() => ({ ok: false }))

    await expect(
      pollUntilReady("https://cdn/dead.mp3", { ...FAST, timeoutMs: 30 })
    ).rejects.toThrow(/timed out after 30ms/)
    const after = probes.calls()
    await new Promise((r) => setTimeout(r, 20))

    expect(probes.calls()).toBe(after)
  })

  it("rejects with the caller's abort reason", async () => {
    stubProbes(() => ({ ok: false }))
    const controller = new AbortController()
    const reason = new Error("user dismissed the dialog")

    const pending = pollUntilReady("https://cdn/x.mp3", {
      ...FAST,
      intervalMs: 1000,
      signal: controller.signal,
    })
    await Promise.resolve()
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it("never probes at all when the signal is already aborted", async () => {
    const probes = stubProbes(() => ({ ok: true }))
    const controller = new AbortController()
    controller.abort(new Error("gone"))

    await expect(
      pollUntilReady("https://cdn/x.mp3", { ...FAST, signal: controller.signal })
    ).rejects.toThrow("gone")
    expect(probes.calls()).toBe(0)
  })
})
