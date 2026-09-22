import { describe, expect, it } from "vitest"
import { useStoragePublicUrl } from "../storagePublicUrl/useStoragePublicUrl.js"

describe("useStoragePublicUrl", () => {
  it("substitutes the path into the active server's template", () => {
    const resolver = useStoragePublicUrl(() => ({
      urlTemplate: "https://cdn.example.com/{path}",
    }))
    expect(resolver.get("public/a/b.mp3")).toBe("https://cdn.example.com/public/a/b.mp3")
  })

  it("reads the active server lazily on each call", () => {
    let template = "https://us.example.com/{path}"
    const resolver = useStoragePublicUrl(() => ({ urlTemplate: template }))
    expect(resolver.get("x")).toBe("https://us.example.com/x")
    template = "https://eu.example.com/{path}"
    expect(resolver.get("x")).toBe("https://eu.example.com/x")
  })
})
