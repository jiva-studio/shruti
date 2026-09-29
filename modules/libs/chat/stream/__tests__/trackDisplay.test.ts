import { describe, expect, it } from "vitest"
import { actionBody, parseTrackCard, parseTrackDisplay } from "../trackDisplay.js"

describe("parseTrackDisplay", () => {
  it("reads the attribution the server resolved", () => {
    expect(
      parseTrackDisplay({
        track_title: "Lecture on BG 2.13",
        author_name: "Speaker",
        date: "1972-01-05",
        references: [
          { source_id: "bg", tokens: "2.13", label: "BG 2.13" },
          { source_id: "sb", tokens: null, label: "ŚB" },
        ],
      })
    ).toEqual({
      trackTitle: "Lecture on BG 2.13",
      authorName: "Speaker",
      trackDate: "1972-01-05",
      references: [
        { sourceId: "bg", tokens: "2.13", label: "BG 2.13" },
        { sourceId: "sb", tokens: null, label: "ŚB" },
      ],
    })
  })

  it("leaves out what the server did not send, and keeps an empty reference list", () => {
    expect(parseTrackDisplay({ text: "quote" })).toEqual({ references: [] })
  })

  it("drops a reference that names no source", () => {
    expect(
      parseTrackDisplay({ references: [7, null, { label: "x" }, { source_id: "bg" }] })
    ).toEqual({ references: [{ sourceId: "bg", tokens: null, label: "" }] })
  })
})

describe("parseTrackCard", () => {
  it("reads a card action's track and attribution", () => {
    expect(
      parseTrackCard({
        kind: "card",
        id: "track_5",
        payload: { track_id: "track_5", track_title: "Found lecture" },
      })
    ).toEqual({ trackId: "track_5", trackTitle: "Found lecture", references: [] })
  })

  it("is null for another kind or a card with no track", () => {
    expect(parseTrackCard({ kind: "verse", payload: { track_id: "t" } })).toBeNull()
    expect(parseTrackCard({ kind: "card", payload: {} })).toBeNull()
    expect(parseTrackCard({ kind: "card" })).toBeNull()
  })
})

describe("actionBody", () => {
  it("is the object under payload, or an empty one", () => {
    expect(actionBody({ payload: { a: 1 } })).toEqual({ a: 1 })
    expect(actionBody({ payload: [1] })).toEqual({})
    expect(actionBody({})).toEqual({})
  })
})
