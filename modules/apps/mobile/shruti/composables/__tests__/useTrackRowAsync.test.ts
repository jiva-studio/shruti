// @vitest-environment jsdom
import { createApp, nextTick, ref, type Ref } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthorId, LocationId, SourceId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"

const repos = vi.hoisted(() => ({
  getTrack: vi.fn(),
  getAuthor: vi.fn(),
  getLocation: vi.fn(),
  getSource: vi.fn(),
}))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      tracks: { getById: repos.getTrack },
      authors: { getById: repos.getAuthor },
      locations: { getById: repos.getLocation },
      sources: { getById: repos.getSource },
    }),
  }),
}))

import { useTrackRowAsync, type TrackRowAsyncRefs } from "../useTrackRowAsync.js"

function track(over: Partial<Track> = {}): Track {
  return {
    id: "track_a" as TrackId,
    authorId: null,
    locationId: null,
    references: [],
    variants: [],
    ...over,
  } as unknown as Track
}

/** Mount the composable in a real component context and hand back its refs. */
function mount(trackId: Ref<string>): TrackRowAsyncRefs {
  let refs!: TrackRowAsyncRefs
  const app = createApp({
    setup() {
      refs = useTrackRowAsync(() => trackId.value)
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return refs
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
}

describe("useTrackRowAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    repos.getTrack.mockResolvedValue(track())
    repos.getAuthor.mockResolvedValue(null)
    repos.getLocation.mockResolvedValue(null)
    repos.getSource.mockResolvedValue(null)
  })

  it("loads the track and its dictionary entries on mount", async () => {
    const t = track({
      authorId: "author_1" as AuthorId,
      locationId: "loc_1" as LocationId,
      references: [{ sourceId: "src_bg" as SourceId, tokens: ["2", "13"] }],
    } as Partial<Track>)
    repos.getTrack.mockResolvedValue(t)
    repos.getAuthor.mockResolvedValue({ id: "author_1", name: "Author" })
    repos.getLocation.mockResolvedValue({ id: "loc_1", name: "Vrindavan" })
    repos.getSource.mockResolvedValue({ id: "src_bg", name: "Bhagavad-gita" })

    const refs = mount(ref("track_a"))
    expect(refs.loading.value).toBe(true)
    await flush()

    expect(refs.loading.value).toBe(false)
    expect(refs.error.value).toBe(false)
    expect(refs.track.value).toEqual(t)
    expect(refs.author.value).toMatchObject({ id: "author_1" })
    expect(refs.location.value).toMatchObject({ id: "loc_1" })
    expect(refs.sourcesById.value.get("src_bg")).toMatchObject({ name: "Bhagavad-gita" })
  })

  it("leaves the dictionary entries empty when the track carries no references", async () => {
    const refs = mount(ref("track_a"))
    await flush()

    expect(refs.author.value).toBeNull()
    expect(refs.location.value).toBeNull()
    expect(refs.sourcesById.value.size).toBe(0)
    expect(repos.getAuthor).not.toHaveBeenCalled()
    expect(repos.getLocation).not.toHaveBeenCalled()
    expect(repos.getSource).not.toHaveBeenCalled()
  })

  it("asks for each referenced source once even when several references share it", async () => {
    repos.getTrack.mockResolvedValue(
      track({
        references: [
          { sourceId: "src_bg" as SourceId, tokens: ["2", "13"] },
          { sourceId: "src_bg" as SourceId, tokens: ["2", "14"] },
          { sourceId: "src_sb" as SourceId, tokens: ["1", "1"] },
        ],
      } as Partial<Track>)
    )
    repos.getSource.mockImplementation(async (id: SourceId) => ({ id, name: `name ${id}` }))

    const refs = mount(ref("track_a"))
    await flush()

    expect(repos.getSource).toHaveBeenCalledTimes(2)
    expect([...refs.sourcesById.value.keys()].sort()).toEqual(["src_bg", "src_sb"])
  })

  it("drops a source the dictionary does not know instead of leaving a hole in the map", async () => {
    repos.getTrack.mockResolvedValue(
      track({
        references: [
          { sourceId: "src_bg" as SourceId, tokens: ["2"] },
          { sourceId: "src_gone" as SourceId, tokens: ["1"] },
        ],
      } as Partial<Track>)
    )
    repos.getSource.mockImplementation(async (id: SourceId) =>
      id === "src_bg" ? { id, name: "Bhagavad-gita" } : null
    )

    const refs = mount(ref("track_a"))
    await flush()

    expect([...refs.sourcesById.value.keys()]).toEqual(["src_bg"])
  })

  it("reports an unknown track as an error with nothing shown", async () => {
    repos.getTrack.mockResolvedValue(null)
    const refs = mount(ref("track_missing"))
    await flush()

    expect(refs.track.value).toBeNull()
    expect(refs.error.value).toBe(true)
    expect(refs.loading.value).toBe(false)
  })

  it("reports a failing lookup as an error rather than throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    repos.getTrack.mockRejectedValue(new Error("db closed"))
    const refs = mount(ref("track_a"))
    await flush()

    expect(refs.error.value).toBe(true)
    expect(refs.loading.value).toBe(false)
  })

  it("clears a previously-shown track when a reload finds nothing", async () => {
    const t = track()
    repos.getTrack.mockResolvedValue(t)
    const refs = mount(ref("track_a"))
    await flush()
    expect(refs.track.value).toEqual(t)

    repos.getTrack.mockResolvedValue(null)
    await refs.reload()
    expect(refs.track.value).toBeNull()
    expect(refs.error.value).toBe(true)
  })

  it("reloads when the id it is given changes", async () => {
    const id = ref("track_a")
    repos.getTrack.mockImplementation(async (tid: TrackId) => track({ id: tid }))
    const refs = mount(id)
    await flush()
    expect(refs.track.value?.id).toBe("track_a")

    id.value = "track_b"
    await nextTick()
    await flush()
    expect(refs.track.value?.id).toBe("track_b")
  })

  it("shows the newest id's data when a slow earlier load lands last", async () => {
    const id = ref("track_slow")
    const pending = new Map<string, (t: Track) => void>()
    repos.getTrack.mockImplementation(
      (tid: TrackId) => new Promise<Track>((resolve) => pending.set(tid, resolve))
    )

    const refs = mount(id)
    await flush()

    id.value = "track_fast"
    await nextTick()
    await flush()

    pending.get("track_fast")!(track({ id: "track_fast" as TrackId }))
    await flush()
    expect(refs.track.value?.id).toBe("track_fast")

    // The stale load for the id the row no longer shows resolves afterwards.
    pending.get("track_slow")!(track({ id: "track_slow" as TrackId }))
    await flush()
    expect(refs.track.value?.id).toBe("track_fast")
    expect(refs.loading.value).toBe(false)
  })

  it("keeps the newest result when a stale load fails after it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const id = ref("track_slow")
    const pending = new Map<string, { reject: (e: Error) => void; resolve: (t: Track) => void }>()
    repos.getTrack.mockImplementation(
      (tid: TrackId) =>
        new Promise<Track>((resolve, reject) => pending.set(tid, { resolve, reject }))
    )

    const refs = mount(id)
    await flush()
    id.value = "track_fast"
    await nextTick()
    await flush()

    pending.get("track_fast")!.resolve(track({ id: "track_fast" as TrackId }))
    await flush()
    pending.get("track_slow")!.reject(new Error("db closed"))
    await flush()

    expect(refs.track.value?.id).toBe("track_fast")
    expect(refs.error.value).toBe(false)
  })
})
