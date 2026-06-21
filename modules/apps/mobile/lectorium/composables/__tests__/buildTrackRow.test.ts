import { describe, expect, it } from "vitest"
import type { LanguageCode, TrackId, AuthorId, LocationId, TagId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"
import type { Author } from "@lib/domain/author.js"
import type { Location } from "@lib/domain/location.js"
import type { Tag } from "@lib/domain/tag.js"
import { buildTrackRow } from "../buildTrackRow.js"

const names = (m: Record<string, string>) => new Map(Object.entries(m) as [LanguageCode, string][])

const variant = (language: LanguageCode, title: string): TrackVariant => ({
  trackId: "t-1" as TrackId,
  language,
  title,
  audios: [],
  audio: null,
  transcript: null,
  outline: null,
  description: null,
})

const track = (variants: TrackVariant[]): Track => ({
  id: "t-1" as TrackId,
  authorId: "a-1" as AuthorId,
  locationId: "l-1" as LocationId,
  date: "1975-01-01" as Track["date"],
  hidden: false,
  references: [],
  tagIds: ["tag-1" as TagId],
  topicIds: [],
  variants,
})

const author: Author = {
  id: "a-1" as AuthorId,
  names: names({
    en: "A. C. Bhaktivedanta Swami Prabhupada",
    ru: "А.Ч. Бхактиведанта Свами Прабхупада",
  }),
}
const location: Location = {
  id: "l-1" as LocationId,
  names: names({ en: "New York", ru: "Нью-Йорк" }),
}
const tag: Tag = {
  id: "tag-1" as TagId,
  names: names({ en: "Conversation", ru: "Беседа" }),
}

const dicts = {
  authorsById: new Map([[author.id, author]]),
  locationsById: new Map([[location.id, location]]),
  tagsById: new Map([[tag.id, tag]]),
}

describe("buildTrackRow — metadata labels follow the content language", () => {
  it("renders a Russian lecture's author/location/tags in Russian even on a non-Russian UI", () => {
    // Ukrainian UI → no uk dictionary values; the library language is ru, so the
    // whole row (title + labels) must read in Russian, not fall back to English.
    const row = buildTrackRow(track([variant("ru", "Аромат души")]), {
      preferredLanguage: "uk" as LanguageCode,
      contentLanguages: ["ru"] as LanguageCode[],
      ...dicts,
    })

    expect(row.title).toBe("Аромат души")
    expect(row.author).toBe("А.Ч. Бхактиведанта Свами Прабхупада")
    expect(row.location).toBe("Нью-Йорк")
    expect(row.tags).toEqual(["Беседа"])
  })

  it("renders an English lecture's labels in English (per-track content language)", () => {
    const row = buildTrackRow(track([variant("en", "The Fragrance of the Soul")]), {
      preferredLanguage: "ru" as LanguageCode,
      contentLanguages: ["en"] as LanguageCode[],
      ...dicts,
    })

    expect(row.title).toBe("The Fragrance of the Soul")
    expect(row.author).toBe("A. C. Bhaktivedanta Swami Prabhupada")
    expect(row.location).toBe("New York")
    expect(row.tags).toEqual(["Conversation"])
  })
})
