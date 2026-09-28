import { describe, expect, it } from "vitest"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { TrackId } from "@lib/domain/core.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import { validateAndScrubActions } from "../markerValidator.js"

function track(id: string): Track {
  return {
    id: id as TrackId,
    authorId: null,
    locationId: null,
    date: "2020-01-01",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [],
  }
}

/** Catalog holding exactly `ids`; every other read is out of scope here. */
function catalogOf(ids: readonly string[]): ITrackRepository {
  const rows = new Map<TrackId, Track>(ids.map((id) => [id as TrackId, track(id)]))
  const unread = (): never => {
    throw new Error("the validator reads tracks by id only")
  }
  return {
    getById: async (id) => rows.get(id) ?? null,
    getByIds: async (wanted) =>
      new Map(wanted.filter((id) => rows.has(id)).map((id) => [id, rows.get(id)!])),
    list: unread,
    search: unread,
    count: unread,
    listYears: unread,
    findByReference: unread,
    getTranscriptPath: unread,
    listTranscriptLanguages: unread,
    getDurationsMs: unread,
    getAudioSizesBytes: unread,
  }
}

function queueAction(id: string, trackId: string): ChatActionPayload {
  return { kind: "queue_next_track", id, trackId }
}

function upgradeAction(id: string): ChatActionPayload {
  return { kind: "upgrade_to_pro", id, reason: "weekly_digest" }
}

describe("validateAndScrubActions", () => {
  it("keeps the body and actions when every queued track exists", async () => {
    const actions = { a1: queueAction("a1", "t-1"), a2: queueAction("a2", "t-2") }
    const body = "Next up [action:queue_next_track|id=a1] then [action:queue_next_track|id=a2]"

    const result = await validateAndScrubActions(body, actions, catalogOf(["t-1", "t-2"]))

    expect(result.degraded).toBe(false)
    expect(result.bodyMd).toBe(body)
    expect(Object.keys(result.actions)).toEqual(["a1", "a2"])
  })

  it("drops the action and its marker when the track is not in the catalog", async () => {
    const actions = { a1: queueAction("a1", "t-gone"), a2: queueAction("a2", "t-2") }
    const body = "Try [action:queue_next_track|id=a1] or [action:queue_next_track|id=a2]"

    const result = await validateAndScrubActions(body, actions, catalogOf(["t-2"]))

    expect(result.degraded).toBe(true)
    expect(Object.keys(result.actions)).toEqual(["a2"])
    expect(result.bodyMd).toBe("Try or [action:queue_next_track|id=a2]")
  })

  it("leaves an action of another kind alone while scrubbing a missing track", async () => {
    const actions = { a1: queueAction("a1", "t-gone"), a2: upgradeAction("a2") }
    const body = "[action:queue_next_track|id=a1][action:upgrade_to_pro|id=a2]"

    const result = await validateAndScrubActions(body, actions, catalogOf([]))

    expect(Object.keys(result.actions)).toEqual(["a2"])
    expect(result.bodyMd).toBe("[action:upgrade_to_pro|id=a2]")
  })

  it("returns the input untouched when no action names a track", async () => {
    const actions = { a2: upgradeAction("a2") }
    const body = "[action:upgrade_to_pro|id=a2]"

    const result = await validateAndScrubActions(body, actions, catalogOf([]))

    expect(result.degraded).toBe(false)
    expect(result.actions).toBe(actions)
    expect(result.bodyMd).toBe(body)
  })

  it("asks for each track once when two actions queue the same one", async () => {
    const asked: TrackId[][] = []
    const catalog = catalogOf(["t-1"])
    const counting: ITrackRepository = {
      ...catalog,
      getByIds: (ids) => {
        asked.push([...ids])
        return catalog.getByIds(ids)
      },
    }
    const actions = { a1: queueAction("a1", "t-1"), a2: queueAction("a2", "t-1") }

    const result = await validateAndScrubActions("body", actions, counting)

    expect(asked).toEqual([["t-1"]])
    expect(result.degraded).toBe(false)
  })
})
