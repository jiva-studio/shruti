import { describe, expect, it } from "vitest"
import type { IPreferences } from "@ports/app/index.js"
import { createPendingTurnStore } from "../chatPendingTurns.js"

/** In-memory IPreferences fake. */
function fakePreferences(): IPreferences {
  const map = new Map<string, string>()
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => void map.set(k, v),
    remove: async (k: string) => void map.delete(k),
  } as IPreferences
}

describe("createPendingTurnStore", () => {
  it("adds, reads back, and dedups by assistantMessageId", async () => {
    const store = createPendingTurnStore(fakePreferences())
    await store.add("a1", "s1")
    await store.add("a1", "s1") // duplicate — must not double-insert
    await store.add("a2", "s1")
    const list = await store.read()
    expect(list.map((p) => p.assistantMessageId)).toEqual(["a1", "a2"])
    expect(list[0]).toMatchObject({ assistantMessageId: "a1", sessionId: "s1" })
  })

  it("removes one entry and clears the key when the list empties", async () => {
    const prefs = fakePreferences()
    const store = createPendingTurnStore(prefs)
    await store.add("a1", "s1")
    await store.add("a2", "s1")
    await store.remove("a1")
    expect((await store.read()).map((p) => p.assistantMessageId)).toEqual(["a2"])
    await store.remove("a2")
    expect(await store.read()).toEqual([])
    expect(await prefs.get("chat:pending_turns")).toBeNull()
  })

  it("returns [] on corrupt / non-array stored JSON", async () => {
    const prefs = fakePreferences()
    await prefs.set("chat:pending_turns", "{not json")
    expect(await createPendingTurnStore(prefs).read()).toEqual([])
    await prefs.set("chat:pending_turns", '{"a":1}')
    expect(await createPendingTurnStore(prefs).read()).toEqual([])
  })
})
