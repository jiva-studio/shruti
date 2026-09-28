import { describe, expect, it } from "vitest"
import { normalizeSource } from "../normalizeSource.js"

describe("normalizeSource", () => {
  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ&t=90",
    "https://youtu.be/dQw4w9WgXcQ?si=abcdef",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "HTTPS://YOUTU.BE/dQw4w9WgXcQ",
  ])("collapses %s onto its video id", (url) => {
    expect(normalizeSource(url)).toBe("yt:dQw4w9WgXcQ")
  })

  it("keeps a non-YouTube link as its trimmed url", () => {
    expect(normalizeSource("  https://vedabase.io/lecture.mp3  ")).toBe(
      "https://vedabase.io/lecture.mp3"
    )
  })

  it("does not read an id out of a youtube url that carries none", () => {
    expect(normalizeSource("https://www.youtube.com/@channel")).toBe(
      "https://www.youtube.com/@channel"
    )
  })

  it("distinguishes two different videos", () => {
    expect(normalizeSource("https://youtu.be/aaaaaaaaaaa")).not.toBe(
      normalizeSource("https://youtu.be/bbbbbbbbbbb")
    )
  })
})
