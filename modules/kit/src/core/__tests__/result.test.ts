import { describe, it, expect } from "vitest"
import { ok, err, unwrap, type Result } from "../result.js"

describe("Result", () => {
  it("ok wraps a value", () => {
    const r = ok(42)
    expect(r).toEqual({ ok: true, value: 42 })
  })

  it("err wraps an error", () => {
    const r = err("not-found")
    expect(r).toEqual({ ok: false, error: "not-found" })
  })

  it("narrows on the ok discriminant", () => {
    const r: Result<number, string> = ok(7)
    if (r.ok) expect(r.value).toBe(7)
    else throw new Error("expected ok")
  })

  it("unwrap returns the value on ok", () => {
    expect(unwrap(ok("x"))).toBe("x")
  })

  it("unwrap throws on err", () => {
    expect(() => unwrap(err({ code: "boom" }))).toThrow(/error Result/)
  })
})
