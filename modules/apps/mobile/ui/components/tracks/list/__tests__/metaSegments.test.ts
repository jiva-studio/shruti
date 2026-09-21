import { describe, expect, it } from "vitest"
import { buildMetaSegments } from "../metaSegments.js"
import { DEFAULT_TRACK_META_CONFIG, type TrackMetaConfig } from "../trackMetaFields.js"

const ALL: TrackMetaConfig = DEFAULT_TRACK_META_CONFIG

const VALUES = {
  references: ["sb 1.8.40", "sb 1.8.41"],
  tags: ["kirtan"],
  location: "Vrindavan",
  date: "1972-10-02",
  duration: "47:12",
}

describe("buildMetaSegments", () => {
  it("keeps the configured order", () => {
    expect(buildMetaSegments(ALL, VALUES).map((s) => s.key)).toEqual([
      "reference",
      "date",
      "duration",
      "location",
    ])
  })

  it("skips a disabled field", () => {
    const config: TrackMetaConfig = { top: null, bottom: [{ field: "date", enabled: false }] }
    expect(buildMetaSegments(config, VALUES).map((s) => s.key)).toEqual(["duration"])
  })

  it("never shows the field promoted to the top widget twice", () => {
    expect(buildMetaSegments({ ...ALL, top: "date" }, VALUES).map((s) => s.key)).not.toContain(
      "date"
    )
  })

  it("counts the references it did not show", () => {
    const [ref] = buildMetaSegments(ALL, VALUES)
    expect(ref).toMatchObject({ kind: "reference", text: "sb 1.8.40", extra: 1 })
  })

  it("falls back to the first tag when there is no reference", () => {
    const [ref] = buildMetaSegments(ALL, { ...VALUES, references: [] })
    expect(ref).toMatchObject({ kind: "reference", text: "kirtan", extra: 0 })
  })

  it("drops a field the track has nothing for", () => {
    const segments = buildMetaSegments(ALL, { duration: "47:12" })
    expect(segments.map((s) => s.key)).toEqual(["duration"])
  })

  it("stands the duration in rather than leave the line blank", () => {
    const config: TrackMetaConfig = { top: null, bottom: [{ field: "location", enabled: true }] }
    expect(buildMetaSegments(config, { duration: "47:12" }).map((s) => s.key)).toEqual(["duration"])
  })

  it("leaves the line empty when there is no duration either", () => {
    expect(buildMetaSegments(ALL, {})).toEqual([])
  })
})
