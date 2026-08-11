import { describe, it, expect, vi } from "vitest"

import { createRegionReprobe } from "../regionWatch.js"

// `startRegionWatch` reaches for the composition root and `@capacitor/app`;
// the rate-limiting and coalescing that make re-probing safe to hang off every
// resume live in the factory, which is what is exercised here.
function harness(probe: () => Promise<string>) {
  let t = 0
  const onResolved = vi.fn()
  const reprobe = createRegionReprobe({
    probe,
    onResolved,
    now: () => t,
    minIntervalMs: 60_000,
  })
  return {
    onResolved,
    /** What an `appStateChange` foreground does. */
    resume: () => reprobe.trigger(),
    /** What an `online` transition does. */
    reconnect: () => reprobe.trigger({ force: true }),
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe("createRegionReprobe", () => {
  it("does not probe on a resume that lands right after the cold-start probe", () => {
    const probe = vi.fn(async () => "russia")
    const h = harness(probe)

    h.resume()

    // The bootstrap probe ran moments ago — re-running it would be a second
    // request for the same answer on every launch.
    expect(probe).not.toHaveBeenCalled()
  })

  it("probes immediately on an `online` transition, floor or no floor", async () => {
    const probe = vi.fn(async () => "russia")
    const h = harness(probe)

    // The radio re-attaching IS the moment a relocation or a VPN flip becomes
    // visible — making it wait out a floor is what leaves the region stale.
    h.reconnect()
    await vi.waitFor(() => expect(h.onResolved).toHaveBeenCalledWith("russia"))

    expect(probe).toHaveBeenCalledOnce()
  })

  it("probes once the interval has elapsed and applies the winner", async () => {
    const probe = vi.fn(async () => "russia")
    const h = harness(probe)

    h.advance(60_001)
    h.resume()
    await vi.waitFor(() => expect(h.onResolved).toHaveBeenCalledWith("russia"))

    expect(probe).toHaveBeenCalledOnce()
  })

  it("collapses a resume and an `online` event into one probe", async () => {
    const probe = vi.fn(async () => "russia")
    const h = harness(probe)

    h.advance(60_001)
    // Coming back from a flight fires both, back to back.
    h.resume()
    h.reconnect()
    await vi.waitFor(() => expect(h.onResolved).toHaveBeenCalledOnce())

    expect(probe).toHaveBeenCalledOnce()
  })

  it("does not start a second probe while one is still in flight", async () => {
    let release!: (id: string) => void
    const probe = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    const h = harness(probe)

    h.advance(60_001)
    h.resume()
    // A slow probe (a blackholed edge burns the full 2500 ms budget) must not
    // be joined by a fresh one every time the user flips back to the app.
    h.advance(120_000)
    h.resume()
    expect(probe).toHaveBeenCalledOnce()

    release("russia")
    await vi.waitFor(() => expect(h.onResolved).toHaveBeenCalledWith("russia"))
  })

  it("keeps the current region and does not throw when every candidate is dead", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const probe = vi.fn(async () => {
      throw new Error("all servers unreachable")
    })
    const h = harness(probe)

    h.advance(60_001)
    expect(() => h.resume()).not.toThrow()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())

    // Offline is not a reason to abandon the region we have.
    expect(h.onResolved).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("re-probes again after a failure once the interval has elapsed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const probe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("russia")
    const h = harness(probe)

    h.advance(60_001)
    h.resume()
    // Let the rejection settle so the in-flight guard has been released.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(probe).toHaveBeenCalledOnce()

    h.advance(60_001)
    h.resume()
    await vi.waitFor(() => expect(h.onResolved).toHaveBeenCalledWith("russia"))
  })
})
