import { describe, expect, it } from "vitest"
import { planProactiveToast } from "../useChatStoreProactiveSync.js"

describe("planProactiveToast", () => {
  it("shows nothing when the unseen set did not grow (idle tick / re-prep)", () => {
    expect(planProactiveToast(0, 0)).toEqual({ kind: "none" })
    expect(planProactiveToast(2, 2)).toEqual({ kind: "none" })
  })

  it("shows nothing when the unseen set shrank (user opened one mid-tick)", () => {
    expect(planProactiveToast(3, 1)).toEqual({ kind: "none" })
  })

  it("shows the single-message toast when exactly one message surfaced", () => {
    expect(planProactiveToast(0, 1)).toEqual({ kind: "single" })
    expect(planProactiveToast(2, 3)).toEqual({ kind: "single" })
  })

  it("groups into one toast carrying the count when several surfaced at once", () => {
    expect(planProactiveToast(0, 3)).toEqual({ kind: "grouped", count: 3 })
    // Counts only the growth, not the total unseen — a pre-existing unseen
    // message must not inflate the batch count.
    expect(planProactiveToast(1, 4)).toEqual({ kind: "grouped", count: 3 })
  })
})
