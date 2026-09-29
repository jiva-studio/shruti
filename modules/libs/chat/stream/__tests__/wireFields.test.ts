import { describe, expect, it } from "vitest"
import {
  eitherNum,
  eitherStr,
  flag,
  list,
  num,
  optStr,
  record,
  str,
  stringMap,
  trimmed,
} from "../wireFields.js"

describe("wireFields", () => {
  it("answers with the fallback rather than throwing on the wrong type", () => {
    expect(str({ a: 1 }, "a")).toBe("")
    expect(str({}, "a", "x")).toBe("x")
    expect(num({ a: "1" }, "a")).toBeNull()
    expect(trimmed({ a: 1 }, "a")).toBe("")
  })

  it("trims, and reads a blank field as absent", () => {
    expect(trimmed({ a: "  x  " }, "a")).toBe("x")
    expect(optStr({ a: "   " }, "a")).toBeUndefined()
    expect(optStr({ a: "x" }, "a")).toBe("x")
  })

  it("takes a flag only on an explicit true", () => {
    expect(flag({ a: true }, "a")).toBe(true)
    expect(flag({ a: 1 }, "a")).toBe(false)
    expect(flag({ a: "true" }, "a")).toBe(false)
  })

  it("does not mistake an array for a record", () => {
    expect(record({ a: [] }, "a")).toBeNull()
    expect(record({ a: { b: 1 } }, "a")).toEqual({ b: 1 })
    expect(list({ a: { b: 1 } }, "a")).toEqual([])
    expect(list({ a: [1] }, "a")).toEqual([1])
  })

  it("keeps only the string entries of a map, and drops the blank ones", () => {
    expect(stringMap({ t: { en: "a", ru: "", de: 3 } }, "t")).toEqual({ en: "a" })
    expect(stringMap({ t: null }, "t")).toEqual({})
  })

  it("reads a field the server may send either way round", () => {
    expect(eitherNum({ resets_at_epoch: 5 }, "resets_at_epoch", "resetsAtEpoch")).toBe(5)
    expect(eitherNum({ resetsAtEpoch: 7 }, "resets_at_epoch", "resetsAtEpoch")).toBe(7)
    expect(eitherNum({}, "resets_at_epoch", "resetsAtEpoch")).toBeUndefined()
    expect(eitherStr({ keyType: "ip" }, "key_type", "keyType")).toBe("ip")
  })

  // 0 is a value, not an absence: `?? ` and `||` disagree here and the chip
  // reads the two differently.
  it("keeps a zero", () => {
    expect(num({ a: 0 }, "a")).toBe(0)
    expect(eitherNum({ current: 0 }, "current", "currentCount")).toBe(0)
  })
})
