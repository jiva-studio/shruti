import { beforeEach, describe, expect, it, vi } from "vitest"

const stores = vi.hoisted(() => ({
  playlist: vi.fn<() => Promise<void>>(),
  notes: vi.fn<() => Promise<void>>(),
  chat: vi.fn<() => Promise<void>>(),
  library: vi.fn<() => Promise<void>>(),
  reportError: vi.fn(),
}))

vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ refresh: stores.playlist }),
}))
vi.mock("@shruti/stores/useNotesStore.js", () => ({
  useNotesStore: () => ({ refresh: stores.notes }),
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({
  useChatStore: () => ({ refreshSessions: stores.chat }),
}))
vi.mock("@shruti/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ refresh: stores.library }),
}))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({
  reportError: stores.reportError,
}))

import { refreshStoresFor } from "../syncStoreRefresh.js"

const ALL = ["playlist_items", "notes", "chat_sessions", "library_items"]

beforeEach(() => {
  vi.clearAllMocks()
  for (const refresh of [stores.playlist, stores.notes, stores.chat, stores.library]) {
    refresh.mockResolvedValue(undefined)
  }
})

describe("refreshStoresFor — a store that fails to refresh", () => {
  it.each([
    ["playlist", stores.playlist],
    ["notes", stores.notes],
    ["chat", stores.chat],
    ["library", stores.library],
  ])("reports the %s failure and still refreshes the others", async (_name, failing) => {
    const boom = new Error("database is locked")
    failing.mockRejectedValueOnce(boom)

    await refreshStoresFor(ALL)

    expect(stores.reportError).toHaveBeenCalledExactlyOnceWith("sync", boom)
    for (const refresh of [stores.playlist, stores.notes, stores.chat, stores.library]) {
      expect(refresh).toHaveBeenCalledOnce()
    }
  })
})
