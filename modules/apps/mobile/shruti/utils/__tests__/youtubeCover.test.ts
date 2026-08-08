import { describe, it, expect } from "vitest"
import { youtubeVideoId, youtubeCoverUrl } from "../youtubeCover.js"

describe("youtubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // The id is not always the first query parameter, and rarely the last.
    ["https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ&t=90s", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("reads the id out of %s", (url, id) => {
    expect(youtubeVideoId(url)).toBe(id)
  })

  it("says nothing about an address that is not YouTube", () => {
    expect(youtubeVideoId("https://audioveda.ru/uploads/store/56e352.mp3")).toBeNull()
    expect(youtubeVideoId(undefined)).toBeNull()
    expect(youtubeVideoId("")).toBeNull()
  })

  // An id is exactly eleven characters. A path segment that merely looks like
  // one is how a plain file ends up wearing somebody else's poster.
  it("does not mistake a short path segment for an id", () => {
    expect(youtubeVideoId("https://youtu.be/short")).toBeNull()
  })
})

describe("youtubeCoverUrl", () => {
  it("builds the poster that always exists, not the one that often does not", () => {
    expect(youtubeCoverUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
    )
  })

  // A site that embeds a video is filed under its own page, with the embed
  // underneath; a channel crawl is the other way round. Either can carry it.
  it("takes whichever address is the YouTube one", () => {
    expect(
      youtubeCoverUrl("https://example.org/talks/12", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    ).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
  })

  it("has no cover for a recording that is a file on somebody's server", () => {
    expect(
      youtubeCoverUrl("https://audioveda.ru/x.mp3", "https://audioveda.ru/audios/7378")
    ).toBeNull()
  })
})
