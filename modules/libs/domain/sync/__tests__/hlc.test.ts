import { describe, expect, it } from "vitest"
import { compareHlc, compareHlcString, hlcNow, hlcToString, parseHlc, type Hlc } from "../hlc.js"

const DEV = "device-a"

describe("hlcNow", () => {
  it("uses the wall clock and a zero counter on the first event", () => {
    expect(hlcNow(DEV, null, 1000)).toEqual({ physical: 1000, counter: 0, deviceId: DEV })
  })

  it("bumps the counter when the clock does not advance", () => {
    const first = hlcNow(DEV, null, 1000)
    const second = hlcNow(DEV, first, 1000)
    expect(second).toEqual({ physical: 1000, counter: 1, deviceId: DEV })
  })

  it("bumps the counter when the clock runs backwards", () => {
    const first = hlcNow(DEV, null, 5000)
    // Wall clock went back to 4000 — physical must not regress.
    const second = hlcNow(DEV, first, 4000)
    expect(second).toEqual({ physical: 5000, counter: 1, deviceId: DEV })
  })

  it("resets the counter when the clock advances", () => {
    const first = hlcNow(DEV, { physical: 1000, counter: 7, deviceId: DEV }, 1000)
    expect(first.counter).toBe(8)
    const advanced = hlcNow(DEV, first, 2000)
    expect(advanced).toEqual({ physical: 2000, counter: 0, deviceId: DEV })
  })

  it("rolls a counter overflow into the next millisecond", () => {
    const saturated: Hlc = { physical: 1000, counter: 99999, deviceId: DEV }
    const next = hlcNow(DEV, saturated, 1000)
    expect(next).toEqual({ physical: 1001, counter: 0, deviceId: DEV })
  })

  it("produces a strictly increasing sequence under a frozen clock", () => {
    let prev = hlcNow(DEV, null, 42)
    for (let i = 0; i < 100; i++) {
      const next = hlcNow(DEV, prev, 42)
      expect(compareHlc(next, prev)).toBeGreaterThan(0)
      prev = next
    }
  })
})

describe("hlcToString / parseHlc", () => {
  it("round-trips a value", () => {
    const hlc: Hlc = { physical: 1718000000000, counter: 3, deviceId: "device-xyz" }
    expect(parseHlc(hlcToString(hlc))).toEqual(hlc)
  })

  it("zero-pads physical and counter to fixed widths", () => {
    expect(hlcToString({ physical: 1000, counter: 2, deviceId: "d" })).toBe(
      "000000000001000:00002:d"
    )
  })

  it("keeps a device id that itself contains colons intact", () => {
    const hlc: Hlc = { physical: 10, counter: 0, deviceId: "a:b:c" }
    expect(parseHlc(hlcToString(hlc))).toEqual(hlc)
  })

  it("throws on a structurally invalid string", () => {
    expect(() => parseHlc("not-an-hlc")).toThrow()
    expect(() => parseHlc("1000:2:")).toThrow()
  })
})

describe("compareHlc", () => {
  it("orders by physical, then counter, then deviceId", () => {
    const base: Hlc = { physical: 1000, counter: 5, deviceId: "b" }
    expect(compareHlc(base, { physical: 1001, counter: 0, deviceId: "a" })).toBeLessThan(0)
    expect(compareHlc(base, { physical: 1000, counter: 6, deviceId: "a" })).toBeLessThan(0)
    expect(compareHlc(base, { physical: 1000, counter: 5, deviceId: "a" })).toBeGreaterThan(0)
    expect(compareHlc(base, { physical: 1000, counter: 5, deviceId: "b" })).toBe(0)
  })

  it("lexicographic string compare agrees with structured compare", () => {
    // The padded serialization is what the server compares as a text column;
    // it must reproduce the structured ordering exactly.
    const samples: Hlc[] = [
      { physical: 999, counter: 4, deviceId: "z" },
      { physical: 1000, counter: 0, deviceId: "a" },
      { physical: 1000, counter: 0, deviceId: "b" },
      { physical: 1000, counter: 12, deviceId: "a" },
      { physical: 1_718_000_000_000, counter: 0, deviceId: "a" },
    ]
    for (const a of samples) {
      for (const b of samples) {
        expect(Math.sign(compareHlcString(hlcToString(a), hlcToString(b)))).toBe(
          Math.sign(compareHlc(a, b))
        )
      }
    }
  })
})
