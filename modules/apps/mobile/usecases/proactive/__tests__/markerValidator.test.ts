import { describe, expect, it } from "vitest"
import { stripActionMarkers } from "../markerValidator.js"

describe("stripActionMarkers", () => {
  it("removes the marker of a dropped action together with its trailing space", () => {
    const body = "Listen next [action:queue_next_track|id=a1] and enjoy."
    expect(stripActionMarkers(body, ["a1"])).toBe("Listen next and enjoy.")
  })

  it("leaves the markers of actions that were kept", () => {
    const body = "[action:queue_next_track|id=a1][action:open_chat|id=a2]"
    expect(stripActionMarkers(body, ["a1"])).toBe("[action:open_chat|id=a2]")
  })

  it("matches an id containing regex metacharacters literally", () => {
    const body = "[action:queue_next_track|id=a.b][action:queue_next_track|id=axb]"
    expect(stripActionMarkers(body, ["a.b"])).toBe("[action:queue_next_track|id=axb]")
  })

  it("returns the body untouched when nothing was dropped", () => {
    const body = "[action:queue_next_track|id=a1]"
    expect(stripActionMarkers(body, [])).toBe(body)
  })
})
