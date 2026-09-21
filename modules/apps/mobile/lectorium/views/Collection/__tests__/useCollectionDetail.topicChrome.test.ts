import { describe, expect, it, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"

// A topic's membership query is the slow part; its name and cover are not in
// it. Waiting for it before putting the header up left a grey hero with no
// title for the duration of the SQL.
const pending: {
  resolve: ((ids: readonly string[]) => void) | null
  promise: Promise<readonly string[]> | null
} = { resolve: null, promise: null }

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      topics: {
        topTrackIds: () =>
          (pending.promise = new Promise<readonly string[]>((r) => {
            pending.resolve = r
          })),
      },
      tracks: { getByIds: async () => new Map() },
      collections: { getCollection: async () => null },
    }),
  }),
}))
vi.mock("@lectorium/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: async () => {},
    topicNamesById: new Map([["topic-1", "Renunciation"]]),
    topicCoverById: new Map([["topic-1", "covers/renunciation.jpg"]]),
  }),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["en"]),
}))
vi.mock("@lectorium/composables/useTrackUiStateMapper.js", () => ({
  useTrackUiStateMapper: () => ({ mapRows: (rows: () => unknown[]) => ({ value: rows() }) }),
}))

import { useCollectionDetail } from "../useCollectionDetail.js"

describe("a topic's hero", () => {
  it("is up before the membership query answers", async () => {
    const scope = effectScope()
    const detail = scope.run(() => useCollectionDetail(ref("topic-1"), ref("topic")))!

    // Let the dictionary await settle; the membership promise is still open.
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()

    expect(detail.title.value).toBe("Renunciation")
    expect(detail.coverKey.value).toBe("covers/renunciation.jpg")
    expect(detail.trackIds.value).toEqual([])

    pending.resolve?.([])
    scope.stop()
  })
})
