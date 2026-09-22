import { describe, expect, it } from "vitest"
import { urlToCacheKey } from "../files/remoteFilesStorage.js"
import { cachePathFor } from "../files/capacitorRemoteFilesStorage.js"

describe("urlToCacheKey", () => {
  it("uses the URL pathname", () => {
    expect(urlToCacheKey("https://cdn.example.com/public/a/b.json")).toBe("/public/a/b.json")
  })

  it("is host-independent (same asset across CDN regions shares a key)", () => {
    const a = urlToCacheKey("https://us.example.com/public/x.mp3")
    const b = urlToCacheKey("https://eu.example.com/public/x.mp3")
    expect(a).toBe(b)
  })

  it("ignores query strings (path only)", () => {
    expect(urlToCacheKey("https://cdn.example.com/x.json?v=2")).toBe("/x.json")
  })
})

describe("cachePathFor", () => {
  it("appends the pathname under the cache dir without a leading slash", () => {
    expect(cachePathFor("filecache", "https://cdn.example.com/public/a/b.json")).toBe(
      "filecache/public/a/b.json"
    )
  })

  it("is host-independent", () => {
    expect(cachePathFor("c", "https://us.example.com/x.mp3")).toBe(
      cachePathFor("c", "https://eu.example.com/x.mp3")
    )
  })
})
