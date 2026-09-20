import { describe, it, expect } from "vitest"
import { useLoading } from "../useLoading.js"

describe("useLoading", () => {
  it("starts not loading", () => {
    const l = useLoading()
    expect(l.isLoading.value).toBe(false)
    expect(l.count.value).toBe(0)
  })

  it("show/hide toggle the flag", () => {
    const l = useLoading()
    l.show()
    expect(l.isLoading.value).toBe(true)
    l.hide()
    expect(l.isLoading.value).toBe(false)
  })

  it("counts concurrent operations (stays loading until the last hides)", () => {
    const l = useLoading()
    l.show()
    l.show()
    expect(l.count.value).toBe(2)
    l.hide()
    expect(l.isLoading.value).toBe(true)
    l.hide()
    expect(l.isLoading.value).toBe(false)
  })

  it("never goes below zero", () => {
    const l = useLoading()
    l.hide()
    l.hide()
    expect(l.count.value).toBe(0)
  })

  it("wrap is loading during the work and clears after", async () => {
    const l = useLoading()
    let resolve!: (v: string) => void
    const p = l.wrap(new Promise<string>((r) => (resolve = r)))
    expect(l.isLoading.value).toBe(true)
    resolve("done")
    await expect(p).resolves.toBe("done")
    expect(l.isLoading.value).toBe(false)
  })

  it("wrap accepts a thunk", async () => {
    const l = useLoading()
    const r = await l.wrap(async () => 42)
    expect(r).toBe(42)
    expect(l.isLoading.value).toBe(false)
  })

  it("wrap clears loading even when the work throws", async () => {
    const l = useLoading()
    await expect(l.wrap(Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(l.isLoading.value).toBe(false)
  })
})
