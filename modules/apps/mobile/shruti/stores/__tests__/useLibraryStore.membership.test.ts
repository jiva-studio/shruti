import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { LibraryItem } from "@lib/domain/libraryItem.js"
import type { TrackId } from "@lib/domain/core.js"

const listAll = vi.fn<() => Promise<readonly LibraryItem[]>>()
const listArchivedIds = vi.fn<() => Promise<ReadonlySet<string>>>()
const setArchived = vi.fn<(id: string) => Promise<void>>(async () => {})
const setActive = vi.fn<(id: string) => Promise<void>>(async () => {})
const submit = vi.fn<() => Promise<{ membership_id: string }>>()
const { requestSync } = vi.hoisted(() => ({ requestSync: vi.fn() }))
const ensurePro = vi.fn(async () => true)
const requestOpen = vi.fn()

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      libraryItems: { listAll },
      libraryMemberships: { listArchivedIds, setArchived, setActive },
    }),
    ingestClient: { submit },
  }),
}))
vi.mock("@shruti/services/syncEvents.js", () => ({ requestSync }))
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ ensurePro }),
}))
vi.mock("@shruti/stores/usePaywallStore.js", () => ({
  usePaywallStore: () => ({ requestOpen }),
}))

import { IngestGatewayError } from "@ports/app/ingest.js"
import { useLibraryStore } from "../useLibraryStore.js"

const YT_WATCH = "https://www.youtube.com/watch?v=abcdefghijk"
const YT_SHORT = "https://youtu.be/abcdefghijk"

function item(id: string, status: LibraryItem["status"], sourceUrl: string | null): LibraryItem {
  return {
    id,
    trackId: status === "ready" ? (`hash-${id}` as TrackId) : null,
    status,
    origin: "private",
    titleRaw: `Lecture ${id}`,
    authorRaw: null,
    locationRaw: null,
    dateRaw: null,
    langHint: null,
    authorId: null,
    locationId: null,
    date: null,
    lang: null,
    error: null,
    audioKey: null,
    transcriptKey: null,
    variants: [],
    duration: null,
    coverKey: null,
    references: [],
    sourceUrl,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as LibraryItem
}

describe("useLibraryStore — memberships and re-add", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    listAll.mockResolvedValue([])
    listArchivedIds.mockResolvedValue(new Set())
    ensurePro.mockResolvedValue(true)
    submit.mockResolvedValue({ membership_id: "job-1" })
  })

  it("hides an archived item from the shelf but still finds it by source", async () => {
    listAll.mockResolvedValue([item("a", "ready", YT_WATCH), item("b", "ready", null)])
    listArchivedIds.mockResolvedValue(new Set(["a"]))
    const s = useLibraryStore()

    await s.refresh()

    expect(s.items.map((i) => i.id)).toEqual(["b"])
    expect(s.hasSource(YT_WATCH)).toBe(false)
    expect(s.findBySource(YT_WATCH)?.id).toBe("a")
    expect(s.getById("a")?.id).toBe("a")
  })

  it("matches the same YouTube lecture across watch and share links", async () => {
    listAll.mockResolvedValue([item("a", "ready", YT_WATCH)])
    const s = useLibraryStore()
    await s.refresh()

    expect(s.hasSource(YT_SHORT)).toBe(true)
    expect(s.findBySource(YT_SHORT)?.id).toBe("a")
  })

  it("treats a blank url as addressing nothing", async () => {
    listAll.mockResolvedValue([item("a", "ready", YT_WATCH)])
    const s = useLibraryStore()
    await s.refresh()

    expect(s.hasSource("   ")).toBe(false)
    expect(s.findBySource("   ")).toBeUndefined()
    expect(s.ingestIdForUrl("   ")).toBeUndefined()
  })

  it("resolves the ingest job id from a matched item after a reload", async () => {
    listAll.mockResolvedValue([item("a", "processing", YT_WATCH)])
    const s = useLibraryStore()
    await s.refresh()

    expect(s.ingestIdForUrl(YT_SHORT)).toBe("a")
    expect(s.ingestIdForUrl("https://example.com/other")).toBeUndefined()
  })

  it("knows the job id of a just-submitted lecture before its row syncs down", async () => {
    const s = useLibraryStore()
    await s.refresh()

    expect(await s.addByUrl(YT_WATCH)).toBe("added")

    expect(s.ingestIdForUrl(YT_SHORT)).toBe("job-1")
  })

  it("patches an item's status from a live poll", async () => {
    listAll.mockResolvedValue([item("a", "processing", YT_WATCH)])
    const s = useLibraryStore()
    await s.refresh()

    s.applyLiveStatus("a", "ready", "hash-a" as TrackId)

    expect(s.getById("a")?.status).toBe("ready")
    expect(s.getById("a")?.trackId).toBe("hash-a")
    expect(s.hasPending).toBe(false)
  })

  it("keeps the known track id when a poll reports none", async () => {
    listAll.mockResolvedValue([item("a", "ready", YT_WATCH)])
    const s = useLibraryStore()
    await s.refresh()

    s.applyLiveStatus("a", "failed", null)

    expect(s.getById("a")?.status).toBe("failed")
    expect(s.getById("a")?.trackId).toBe("hash-a")
  })

  it("ignores a live status for an unknown item or one that did not change", async () => {
    listAll.mockResolvedValue([item("a", "ready", YT_WATCH)])
    const s = useLibraryStore()
    await s.refresh()
    const before = s.getById("a")

    s.applyLiveStatus("nope", "ready", null)
    s.applyLiveStatus("a", "ready", "hash-a" as TrackId)

    expect(s.getById("a")).toBe(before)
  })

  it("tracks and clears the live pipeline stage and its percent", async () => {
    const s = useLibraryStore()

    s.setLiveStage("a", "downloading", 40)
    expect(s.liveStages.get("a")).toBe("downloading")
    expect(s.livePercents.get("a")).toBe(40)

    s.setLiveStage("a", "transcribing")
    expect(s.liveStages.get("a")).toBe("transcribing")
    expect(s.livePercents.has("a")).toBe(false)

    s.setLiveStage("a", undefined)
    expect(s.liveStages.has("a")).toBe(false)
  })

  it("keeps the stage maps identical when nothing changed", () => {
    const s = useLibraryStore()
    s.setLiveStage("a", "downloading", 40)
    const stages = s.liveStages
    const percents = s.livePercents

    s.setLiveStage("a", "downloading", 40)

    expect(s.liveStages).toBe(stages)
    expect(s.livePercents).toBe(percents)
  })

  it("removing archives the membership and re-reads the shelf", async () => {
    listAll.mockResolvedValue([item("a", "ready", YT_WATCH)])
    const s = useLibraryStore()
    await s.refresh()
    listArchivedIds.mockResolvedValue(new Set(["a"]))

    await s.remove("a")

    expect(setArchived).toHaveBeenCalledWith("a")
    expect(requestSync).toHaveBeenCalled()
    expect(s.items).toEqual([])
  })

  it("re-adding a removed healthy lecture un-archives it without a re-ingest", async () => {
    listAll.mockResolvedValue([item("a", "ready", YT_WATCH)])
    listArchivedIds.mockResolvedValue(new Set(["a"]))
    const s = useLibraryStore()
    await s.refresh()
    listArchivedIds.mockResolvedValue(new Set())

    expect(await s.addByUrl(YT_SHORT)).toBe("added")

    expect(setActive).toHaveBeenCalledWith("a")
    expect(submit).not.toHaveBeenCalled()
    expect(s.items.map((i) => i.id)).toEqual(["a"])
  })

  it("re-adding a removed FAILED lecture un-archives it and re-runs the ingest", async () => {
    listAll.mockResolvedValue([item("a", "failed", YT_WATCH)])
    listArchivedIds.mockResolvedValue(new Set(["a"]))
    const s = useLibraryStore()
    await s.refresh()
    listArchivedIds.mockResolvedValue(new Set())

    expect(await s.addByUrl(YT_WATCH)).toBe("added")

    expect(setActive).toHaveBeenCalledWith("a")
    expect(submit).toHaveBeenCalledOnce()
  })

  it("retries an active failed lecture without touching its membership", async () => {
    listAll.mockResolvedValue([item("a", "failed", YT_WATCH)])
    const s = useLibraryStore()
    await s.refresh()

    expect(await s.addByUrl(YT_WATCH)).toBe("added")

    expect(setActive).not.toHaveBeenCalled()
    expect(submit).toHaveBeenCalledOnce()
  })

  it("does nothing for a lecture that is already ingesting", async () => {
    listAll.mockResolvedValue([item("a", "processing", YT_WATCH)])
    const s = useLibraryStore()
    await s.refresh()

    expect(await s.addByUrl(YT_WATCH)).toBe("added")

    expect(submit).not.toHaveBeenCalled()
  })

  it("passes the title and author hints through to the ingest API", async () => {
    const s = useLibraryStore()

    await s.addByUrl(YT_WATCH, { title: "Lecture", author: "Author" })

    expect(submit).toHaveBeenCalledWith({
      url: YT_WATCH,
      title: "Lecture",
      author: "Author",
    })
  })

  it("bounces a non-subscriber to the paywall before reaching the ingest API", async () => {
    ensurePro.mockResolvedValue(false)
    const s = useLibraryStore()

    expect(await s.addByUrl(YT_WATCH)).toBe("paywalled")

    expect(submit).not.toHaveBeenCalled()
  })

  it("opens the paywall when the gateway itself refuses a non-PRO submit", async () => {
    submit.mockRejectedValue(new IngestGatewayError(402, "pro required", "not_pro"))
    const s = useLibraryStore()

    expect(await s.addByUrl(YT_WATCH)).toBe("paywalled")

    expect(requestOpen).toHaveBeenCalled()
  })

  it("reports a gateway rejection that is not a PRO gate as a failure", async () => {
    submit.mockRejectedValue(new IngestGatewayError(500, "boom"))
    const s = useLibraryStore()

    const result = await s.addByUrl(YT_WATCH)

    expect(result).toMatchObject({ kind: "failed" })
    expect(requestOpen).not.toHaveBeenCalled()
  })

  it("clears the in-flight guard so a later add can submit again", async () => {
    const s = useLibraryStore()

    await s.addByUrl(YT_WATCH)
    await s.addByUrl(YT_WATCH)

    expect(submit).toHaveBeenCalledTimes(2)
  })
})
