import { describe, expect, it } from "vitest"
import type { DiscoveryHit } from "../discoveryClient.js"
import { resolveDiscoverySource } from "../discoverySource.js"

describe("resolveDiscoverySource", () => {
  it("identifies youtube from media_url", () => {
    const hit: DiscoveryHit = {
      item_id: 1,
      media_url: "https://www.youtube.com/watch?v=12345",
      title: "Talk on Gita",
      score: 1.0,
    }
    const source = resolveDiscoverySource(hit)
    expect(source.name).toBe("YouTube")
    expect(source.isYoutube).toBe(true)
  })

  it("identifies youtube from youtu.be shortlinks", () => {
    const hit: DiscoveryHit = {
      item_id: 2,
      media_url: "https://youtu.be/12345",
      title: "Talk on Gita",
      score: 1.0,
    }
    const source = resolveDiscoverySource(hit)
    expect(source.name).toBe("YouTube")
    expect(source.isYoutube).toBe(true)
  })

  it("extracts hostname for web lectures", () => {
    const hit: DiscoveryHit = {
      item_id: 3,
      media_url: "https://audioveda.ru/uploads/file.mp3",
      page_url: "https://audioveda.ru/audios/123",
      title: "Talk on Karma",
      score: 1.0,
    }
    const source = resolveDiscoverySource(hit)
    expect(source.name).toBe("audioveda.ru")
    expect(source.isYoutube).toBe(false)
  })

  it("prefers explicit source string if provided", () => {
    const hit: DiscoveryHit = {
      item_id: 4,
      media_url: "https://example.com/lecture.mp3",
      source: "Bhakti Sanga Channel",
      title: "Bhagavatam",
      score: 1.0,
    }
    const source = resolveDiscoverySource(hit)
    expect(source.name).toBe("Bhakti Sanga Channel")
    expect(source.isYoutube).toBe(false)
  })
})
