import { ref } from "vue"
import { describe, expect, it, vi, beforeEach } from "vitest"

// The composable is a thin wrapper over `useConfig` (the IPreferences-backed
// binder, covered on its own in kit's useConfig.test.ts). We mock it here to
// lock the two load-bearing facts the chat-journaling lane depends on: the
// Preferences key and the default value (ON).
const useConfig = vi.fn((_key: string, initial: unknown) => ref(initial))
vi.mock("@shruti/composables/useConfig.js", () => ({
  useConfig: (key: string, initial: unknown) => useConfig(key, initial),
}))

import { SYNC_CHATS_ENABLED_KEY, useSyncChatsEnabled } from "../useSyncChats.js"

describe("useSyncChatsEnabled", () => {
  beforeEach(() => {
    useConfig.mockClear()
  })

  it("binds the device-local sync-chats preference key", () => {
    expect(SYNC_CHATS_ENABLED_KEY).toBe("settings.syncChatsEnabled")
    useSyncChatsEnabled()
    expect(useConfig).toHaveBeenCalledWith(SYNC_CHATS_ENABLED_KEY, true)
  })

  it("defaults to ON so chats sync unless the user opts out", () => {
    const enabled = useSyncChatsEnabled()
    expect(enabled.value).toBe(true)
  })
})
