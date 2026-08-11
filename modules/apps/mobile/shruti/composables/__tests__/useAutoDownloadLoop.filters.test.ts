// @vitest-environment jsdom
import { createApp, reactive, ref, type Ref } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackListQuery } from "@lib/domain/ports/trackRepository.js"

/**
 * The auto-download loop queries the library through `TrackListFilters`, so a
 * dimension the Smart Library sheet offers but the loop never forwards is a
 * filter the user set and the app ignored (#1585). This drives the loop once
 * and inspects the query it actually issues.
 */
const ctx = vi.hoisted(() => ({
  config: null as unknown as Map<string, Ref<unknown>>,
  filters: null as unknown as Record<string, unknown>,
  list: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@shruti/composables/useConfig.js", () => ({
  useConfig: (key: string, initial: unknown) => {
    const existing = ctx.config.get(key)
    if (existing) return existing
    const created = ref(initial)
    ctx.config.set(key, created)
    return created
  },
}))
vi.mock("@shruti/stores/useAutoDownloadFiltersStore.js", () => ({
  useAutoDownloadFiltersStore: () => ctx.filters,
}))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    entries: [],
    completedAtMap: new Map(),
    getCompletedAt: () => null,
    getProgressMs: () => 0,
    add: vi.fn(async () => ({ ok: false, error: "already-in-playlist" })),
  }),
}))
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ isSubscribed: true }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    databases: { content: {}, user: {} },
    repositories: () => ({
      playlistItems: { listActive: async () => [], listArchived: async () => [] },
      tracks: { getByIds: async () => new Map<TrackId, Track>(), list: ctx.list },
    }),
  }),
}))

import { AUTO_DOWNLOAD_TARGET_SECONDS_KEY, useAutoDownloadLoop } from "../useAutoDownloadLoop.js"

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

function mountLoop(): ReturnType<typeof createApp> {
  const app = createApp({
    setup() {
      useAutoDownloadLoop()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return app
}

beforeEach(() => {
  ctx.config = new Map<string, Ref<unknown>>([[AUTO_DOWNLOAD_TARGET_SECONDS_KEY, ref(3600)]])
  ctx.filters = reactive({
    authorIds: [],
    locationIds: [],
    languageCodes: [],
    sourceIds: [],
    tagIds: [],
    topicIds: ["topic-a", "topic-b"],
    duration: [],
    sort: undefined,
    dateFrom: undefined,
    dateTo: undefined,
    load: vi.fn(async () => {}),
  })
  // One empty page ends the walk immediately; the query is what matters.
  ctx.list = vi.fn(async () => [])
})

describe("useAutoDownloadLoop — filters", () => {
  it("forwards the chosen topics to the library query", async () => {
    const app = mountLoop()
    await flush()

    expect(ctx.list).toHaveBeenCalled()
    const query = ctx.list.mock.calls[0]?.[0] as TrackListQuery
    expect(query.filters?.topicIds).toEqual(["topic-a", "topic-b"])
    app.unmount()
  })

  it("re-queries when the topic selection changes", async () => {
    const app = mountLoop()
    await flush()
    ctx.list.mockClear()
    ;(ctx.filters as { topicIds: readonly string[] }).topicIds = ["topic-c"]
    await flush()

    expect(ctx.list).toHaveBeenCalled()
    const query = ctx.list.mock.calls[0]?.[0] as TrackListQuery
    expect(query.filters?.topicIds).toEqual(["topic-c"])
    app.unmount()
  })
})
