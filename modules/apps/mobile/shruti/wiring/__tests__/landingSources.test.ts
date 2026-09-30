import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LanguageCode } from "@lib/domain/core.js"

const ctx = vi.hoisted(() => ({
  repositories: null as unknown as () => unknown,
}))

vi.mock("@shruti/services/regionsRegistry.js", () => ({
  resolveAssetUrl: (key: string | undefined) => (key ? `https://cdn.example/${key}` : undefined),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({ repositories: () => ctx.repositories() }),
}))

import { useLandingSources } from "../landingSources.js"

const RU = "ru" as LanguageCode

beforeEach(() => {
  ctx.repositories = () => ({
    tracks: { count: async () => 7 },
    collections: {
      listGroups: async () => [{ id: "g1", name: "Group g1", description: "" }],
      listCollections: async () => [],
      getGroupCollections: async () => [
        { id: "c1", name: "Collection c1", cover: "covers/c1.jpg", sort_order: 1 },
      ],
    },
  })
})

describe("useLandingSources", () => {
  it("answers null while the databases are not open", () => {
    ctx.repositories = () => {
      throw new Error("databases are not open")
    }

    expect(useLandingSources()()).toBeNull()
  })

  it("binds the reads to the open repositories", async () => {
    const sources = useLandingSources()()

    expect(await sources?.lectureCount([RU])).toBe(7)
  })

  it("resolves cover keys against the active region", async () => {
    const sources = useLandingSources()()

    const { groups } = (await sources?.collections("en")) ?? { groups: [] }
    expect(groups[0]?.collections[0]?.coverUrl).toBe("https://cdn.example/covers/c1.jpg")
  })
})
