import { describe, it, expect, vi } from "vitest"
import type { Lectorium } from "@lectorium/lectorium.js"

const reset = vi.fn()
vi.mock("@lectorium/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => ({ reset }),
}))

import { useDangerActions } from "../useDangerActions.js"

describe("useDangerActions.onClearCache", () => {
  it("deletes cached files, drops the media-items index, and resets the download store", async () => {
    reset.mockClear()
    const clearAllFiles = vi.fn().mockResolvedValue(undefined)
    const clearAllMedia = vi.fn().mockResolvedValue(undefined)
    const app = {
      filesStorage: { clearAll: clearAllFiles },
      repositories: () => ({ mediaItems: { clearAll: clearAllMedia } }),
    } as unknown as Lectorium

    await useDangerActions(app).onClearCache()

    // Without the media-items wipe, offline rows would stay "downloaded"
    // while their files are gone — the bug this guards against.
    expect(clearAllFiles).toHaveBeenCalledOnce()
    expect(clearAllMedia).toHaveBeenCalledOnce()
    expect(reset).toHaveBeenCalledOnce()
  })
})
