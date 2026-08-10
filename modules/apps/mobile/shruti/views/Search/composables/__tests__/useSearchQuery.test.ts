import { describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { Track } from "@lib/domain/track.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { FiltersModel } from "@ui/features/tracks/search/filters/index.js"
import { useSearchQuery } from "../useSearchQuery.js"

const PAGE_SIZE = 50

function page(offset: number): Track[] {
  return Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `t-${offset + i}` }) as Track)
}

interface Pending {
  resolve: (tracks: readonly Track[]) => void
  reject: (err: Error) => void
}

/** Repo whose `search()` hands back a promise the test settles by hand. */
function setup(): { calls: Pending[]; search: ReturnType<typeof useSearchQuery> } {
  const calls: Pending[] = []
  const tracks = {
    search: vi.fn(
      () => new Promise<readonly Track[]>((resolve, reject) => calls.push({ resolve, reject }))
    ),
  } as unknown as ITrackRepository
  return {
    calls,
    search: useSearchQuery({ query: ref("кришна"), filters: ref({} as FiltersModel), tracks }),
  }
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 0))
  expect(cond()).toBe(true)
}

describe("useSearchQuery", () => {
  it("holds a page fetch behind the in-flight query (#1629)", async () => {
    const { calls, search } = setup()

    const first = search.runQuery()
    expect(calls).toHaveLength(1)
    void search.loadMore()
    expect(calls).toHaveLength(1)

    calls[0].resolve(page(0))
    await first
    expect(calls).toHaveLength(1)
    expect(search.hasMore.value).toBe(true)
  })

  it("runs a query raised while a page was loading", async () => {
    const { calls, search } = setup()
    const first = search.runQuery()
    calls[0].resolve(page(0))
    await first

    const loading = search.loadMore()
    expect(calls).toHaveLength(2)
    void search.runQuery()
    // Queued, not fired alongside the page — that concurrency is what the
    // gate exists to prevent.
    expect(calls).toHaveLength(2)
    calls[1].resolve(page(PAGE_SIZE))
    await waitFor(() => calls.length === 3)
    calls[2].resolve([])
    await loading

    expect(search.rawTracks.value).toEqual([])
  })

  it("disarms infinite scroll when a page fails", async () => {
    const { calls, search } = setup()
    const first = search.runQuery()
    calls[0].resolve(page(0))
    await first

    const loading = search.loadMore()
    calls[1].reject(new Error("database is locked"))
    await loading

    expect(search.error.value).toBe("database is locked")
    expect(search.hasMore.value).toBe(false)
    expect(search.rawTracks.value).toHaveLength(PAGE_SIZE)
  })

  it("reports a failed query instead of leaving a blank pane", async () => {
    const { calls, search } = setup()

    const running = search.runQuery()
    calls[0].reject(new Error("no such table: tracks_search"))
    await running

    expect(search.error.value).toBe("no such table: tracks_search")
    expect(search.rawTracks.value).toEqual([])
    expect(search.isLoading.value).toBe(false)
  })
})
