import { describe, expect, it } from "vitest"
import { parseActionPayload } from "../sseActionParser.js"

function action(kind: string, payload: unknown, id = "a1") {
  return parseActionPayload({ kind, id, payload })
}

describe("parseActionPayload — envelope", () => {
  it("drops an action with no kind or no id", () => {
    expect(parseActionPayload({ id: "a1", payload: {} })).toBeNull()
    expect(parseActionPayload({ kind: "upgrade_to_pro", payload: {} })).toBeNull()
  })

  it("drops an action whose body is missing or not an object", () => {
    expect(parseActionPayload({ kind: "upgrade_to_pro", id: "a1" })).toBeNull()
    expect(action("upgrade_to_pro", ["reason"])).toBeNull()
  })

  it("drops a kind this build knows nothing about", () => {
    expect(action("summon_ui", { anything: 1 })).toBeNull()
  })

  it("wraps a card payload under its kind and id", () => {
    expect(action("verse", { source_id: "bg", tokens: "2.13" })).toMatchObject({
      kind: "verse",
      id: "a1",
      payload: { source_id: "bg", tokens: "2.13" },
    })
  })

  it("drops a card whose own payload does not validate", () => {
    expect(action("verse", { tokens: "2.13" })).toBeNull()
  })
})

describe("parseActionPayload — share_pdf", () => {
  it("reads an item with its references and tags", () => {
    expect(
      action("share_pdf", {
        items: [
          {
            track_id: "t1",
            transcript_key: "k/en.json",
            lang: "en",
            title: "A lecture",
            author: "A Speaker",
            date: "2024-01-02",
            location: "Vrindavan",
            references: [
              { short_name: "BG", full_name: "Bhagavad-gita", source_id: "bg", tokens: "2.13" },
              "not an object",
            ],
            tags: ["featured", 7],
          },
        ],
      })
    ).toEqual({
      kind: "share_pdf",
      id: "a1",
      payload: {
        items: [
          {
            trackId: "t1",
            lang: "en",
            title: "A lecture",
            author: "A Speaker",
            date: "2024-01-02",
            location: "Vrindavan",
            references: [
              { shortName: "BG", fullName: "Bhagavad-gita", sourceId: "bg", tokens: "2.13" },
            ],
            tags: ["featured"],
            transcriptKey: "k/en.json",
          },
        ],
      },
    })
  })

  it("labels an untitled item with its track id", () => {
    const parsed = action("share_pdf", {
      items: [{ track_id: "t1", transcript_key: "k.json" }],
    })
    expect(parsed).toMatchObject({ payload: { items: [{ title: "t1", author: null }] } })
  })

  it("drops an item with no track id or no transcript", () => {
    expect(action("share_pdf", { items: [{ transcript_key: "k.json" }] })).toBeNull()
    expect(action("share_pdf", { items: [{ track_id: "t1" }] })).toBeNull()
  })
})

describe("parseActionPayload — enable_daily_reminder", () => {
  it("keeps a valid time", () => {
    expect(action("enable_daily_reminder", { time: "23:59" })).toEqual({
      kind: "enable_daily_reminder",
      id: "a1",
      payload: { time: "23:59" },
    })
    expect(action("enable_daily_reminder", { time: "6:05" })).toMatchObject({
      payload: { time: "6:05" },
    })
  })

  it("falls back to the default for an impossible time", () => {
    for (const time of ["24:00", "12:60", "noon", ""]) {
      expect(action("enable_daily_reminder", { time })).toMatchObject({
        payload: { time: "07:00" },
      })
    }
  })
})

describe("parseActionPayload — configure_smart_library", () => {
  it("reads the filters the server sent", () => {
    expect(
      action("configure_smart_library", {
        filters: { author_ids: ["a1"], tag_ids: ["tg1", 2], language_codes: ["ru"] },
      })
    ).toEqual({
      kind: "configure_smart_library",
      id: "a1",
      payload: {
        filters: {
          authorIds: ["a1"],
          tagIds: ["tg1"],
          sourceIds: undefined,
          locationIds: undefined,
          languageCodes: ["ru"],
        },
      },
    })
  })

  it("leaves a filter unset when the server sent it empty or not at all", () => {
    const parsed = action("configure_smart_library", { filters: { author_ids: [] } })
    expect(parsed).toMatchObject({
      payload: { filters: { authorIds: undefined, tagIds: undefined } },
    })
  })

  it("leaves every filter unset when there is no filters object", () => {
    expect(action("configure_smart_library", {})).toMatchObject({
      payload: { filters: { authorIds: undefined, languageCodes: undefined } },
    })
  })
})

describe("parseActionPayload — upgrade_to_pro", () => {
  it("keeps the server's reason", () => {
    expect(action("upgrade_to_pro", { reason: "chat_limit" })).toEqual({
      kind: "upgrade_to_pro",
      id: "a1",
      payload: { reason: "chat_limit" },
    })
  })

  it("falls back to a generic reason", () => {
    expect(action("upgrade_to_pro", {})).toMatchObject({ payload: { reason: "generic" } })
  })
})

describe("parseActionPayload — add_to_library", () => {
  it("reads the suggestion", () => {
    expect(
      action("add_to_library", {
        url: "https://youtu.be/xyz",
        title: "A lecture",
        author: "A Speaker",
        thumbnail: "https://img/xyz.jpg",
      })
    ).toEqual({
      kind: "add_to_library",
      id: "a1",
      payload: {
        url: "https://youtu.be/xyz",
        title: "A lecture",
        author: "A Speaker",
        thumbnail: "https://img/xyz.jpg",
      },
    })
  })

  it("drops a suggestion with nothing to add", () => {
    expect(action("add_to_library", { title: "A lecture" })).toBeNull()
  })

  it("has no author or thumbnail when the server sent none", () => {
    expect(action("add_to_library", { url: "https://youtu.be/xyz" })).toMatchObject({
      payload: { title: "", author: null, thumbnail: null },
    })
  })
})
