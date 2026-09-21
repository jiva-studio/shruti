import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { ChatActionPayload, ChatActionState } from "@lib/domain"
import type { ChatMessageId, TrackId } from "@lib/domain/core.js"
import type { IChatMessageRepository, IProactiveStateRepository } from "@lib/domain/ports/index.js"
import type { INotificationScheduler } from "@ports/app/index.js"
import type { ChatMessage } from "../chatTypes.js"

const h = vi.hoisted(() => ({
  applyDailyReminder: vi.fn(async () => {}),
  recordInlineHintCooldownUC: vi.fn(async () => {}),
  requestOpen: vi.fn(),
  ensurePro: vi.fn(async () => true),
  addByUrl: vi.fn(async () => "added" as string),
  configValues: new Map<string, { value: unknown }>(),
}))

vi.mock("@lectorium/composables/useDailyReminder.js", () => ({
  applyDailyReminder: h.applyDailyReminder,
}))
vi.mock("@usecases", () => ({ recordInlineHintCooldown: h.recordInlineHintCooldownUC }))
vi.mock("@lectorium/composables/useConfig.js", () => ({
  useConfig: (key: string, fallback: unknown) => {
    if (!h.configValues.has(key)) h.configValues.set(key, ref(fallback) as { value: unknown })
    return h.configValues.get(key)!
  },
}))
vi.mock("@lectorium/stores/usePaywallStore.js", () => ({
  usePaywallStore: () => ({ requestOpen: h.requestOpen }),
}))
vi.mock("@lectorium/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ ensurePro: h.ensurePro }),
}))
vi.mock("@lectorium/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ addByUrl: h.addByUrl }),
}))

const filterWrites: [string, readonly string[]][] = []
const autoDownloadLoad = vi.fn(async () => {})
vi.mock("@lectorium/stores/useAutoDownloadFiltersStore.js", () => ({
  useAutoDownloadFiltersStore: () => ({
    load: autoDownloadLoad,
    setAuthors: async (v: readonly string[]) => void filterWrites.push(["authors", v]),
    setTags: async (v: readonly string[]) => void filterWrites.push(["tags", v]),
    setSources: async (v: readonly string[]) => void filterWrites.push(["sources", v]),
    setLocations: async (v: readonly string[]) => void filterWrites.push(["locations", v]),
    setLanguages: async (v: readonly string[]) => void filterWrites.push(["languages", v]),
  }),
}))

import { useChatActions } from "../useChatActions.js"

const MSG = "m-1"
const ACT = "act-1"

function harness(action: ChatActionPayload, state?: ChatActionState) {
  const messages = ref<ChatMessage[]>([
    {
      id: MSG as ChatMessageId,
      actions: { [ACT]: action },
      actionStates: state ? { [ACT]: state } : undefined,
    } as unknown as ChatMessage,
  ])
  const persisted: Record<string, ChatActionState>[] = []
  const updateActionStates = vi.fn<
    (id: ChatMessageId, s: Record<string, ChatActionState>) => Promise<void>
  >(async (_id, s) => void persisted.push({ ...s }))
  const addToQueue = vi.fn<(id: TrackId) => Promise<{ ok: boolean; error?: string }>>(async () => ({
    ok: true,
  }))
  const proactive = {} as IProactiveStateRepository
  const actions = useChatActions({
    messages,
    chatMessages: () => ({ updateActionStates }) as unknown as IChatMessageRepository,
    proactiveState: () => proactive,
    notifications: { marker: "notifications" } as unknown as INotificationScheduler,
    addToQueue,
    t: (k) => `t:${k}`,
  })
  const stateOf = (): ChatActionState | undefined =>
    (messages.value[0].actionStates as Record<string, ChatActionState> | undefined)?.[ACT]
  return { actions, messages, persisted, updateActionStates, addToQueue, stateOf, proactive }
}

describe("useChatActions.executeAction", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    filterWrites.length = 0
    h.configValues.clear()
    h.ensurePro.mockResolvedValue(true)
    h.addByUrl.mockResolvedValue("added")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "debug").mockImplementation(() => {})
  })

  it("marks a paywall card done and opens the paywall", async () => {
    const t = harness({ kind: "upgrade_to_pro", id: ACT } as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT)

    expect(h.requestOpen).toHaveBeenCalled()
    expect(t.stateOf()).toBe("done")
    expect(t.persisted).toEqual([{ [ACT]: "executing" }, { [ACT]: "done" }])
  })

  it("ignores an action id the message does not carry", async () => {
    const t = harness({ kind: "upgrade_to_pro", id: ACT } as ChatActionPayload)

    await t.actions.executeAction(MSG, "other")

    expect(t.persisted).toEqual([])
  })

  it("ignores a message that is not in the thread", async () => {
    const t = harness({ kind: "upgrade_to_pro", id: ACT } as ChatActionPayload)

    await t.actions.executeAction("gone", ACT)

    expect(t.persisted).toEqual([])
  })

  it("refuses to re-run an already confirmed card", async () => {
    const t = harness({ kind: "upgrade_to_pro", id: ACT } as ChatActionPayload, "done")

    await t.actions.executeAction(MSG, ACT)

    expect(h.requestOpen).not.toHaveBeenCalled()
  })

  it("refuses to re-run a card that is mid-flight", async () => {
    const t = harness({ kind: "upgrade_to_pro", id: ACT } as ChatActionPayload, "executing")

    await t.actions.executeAction(MSG, ACT)

    expect(h.requestOpen).not.toHaveBeenCalled()
  })

  it("leaves an errored card retryable", async () => {
    const t = harness({ kind: "upgrade_to_pro", id: ACT } as ChatActionPayload, "error")

    await t.actions.executeAction(MSG, ACT)

    expect(t.stateOf()).toBe("done")
  })

  it("keeps the card usable when persisting its state fails", async () => {
    const t = harness({ kind: "upgrade_to_pro", id: ACT } as ChatActionPayload)
    t.updateActionStates.mockRejectedValue(new Error("db locked"))

    await t.actions.executeAction(MSG, ACT)

    expect(t.stateOf()).toBe("done")
  })

  it("queues the next track and confirms the card", async () => {
    const t = harness({ kind: "queue_next_track", id: ACT, trackId: "t-9" } as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT)

    expect(t.addToQueue).toHaveBeenCalledWith("t-9")
    expect(t.stateOf()).toBe("done")
  })

  it("treats an already-queued track as confirmed rather than an error", async () => {
    const t = harness({ kind: "queue_next_track", id: ACT, trackId: "t-9" } as ChatActionPayload)
    t.addToQueue.mockResolvedValue({ ok: false, error: "already-in-playlist" })

    await t.actions.executeAction(MSG, ACT)

    expect(t.stateOf()).toBe("done")
  })

  it("marks the card errored when queueing genuinely fails", async () => {
    const t = harness({ kind: "queue_next_track", id: ACT, trackId: "t-9" } as ChatActionPayload)
    t.addToQueue.mockResolvedValue({ ok: false, error: "no-audio" })

    await t.actions.executeAction(MSG, ACT)

    expect(t.stateOf()).toBe("error")
  })

  it("enables the reminder toggle and arms the alarm at the card's time", async () => {
    const t = harness({
      kind: "enable_daily_reminder",
      id: ACT,
      time: "07:30",
    } as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT)

    expect(h.configValues.get("settings.notificationsEnabled")?.value).toBe(true)
    expect(h.configValues.get("settings.notificationsTime")?.value).toEqual([7, 30])
    expect(h.applyDailyReminder).toHaveBeenCalledWith(
      { enabled: true, time: "07:30", title: "t:app.title", body: "t:notifications.timeToListen" },
      { notifications: { marker: "notifications" } }
    )
    expect(t.stateOf()).toBe("done")
  })

  it("prefers the time the user picked on the card", async () => {
    const t = harness({
      kind: "enable_daily_reminder",
      id: ACT,
      time: "07:30",
    } as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT, { time: "21:05" })

    expect(h.configValues.get("settings.notificationsTime")?.value).toEqual([21, 5])
  })

  it("errors on an out-of-range time instead of arming a broken alarm", async () => {
    const t = harness({
      kind: "enable_daily_reminder",
      id: ACT,
      time: "25:99",
    } as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT)

    expect(h.applyDailyReminder).not.toHaveBeenCalled()
    expect(t.stateOf()).toBe("error")
  })

  it("writes only the smart-library facets the payload names", async () => {
    const t = harness({
      kind: "configure_smart_library",
      id: ACT,
      filters: { authorIds: ["a1"], languageCodes: ["en"] },
    } as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT)

    expect(autoDownloadLoad).toHaveBeenCalled()
    expect(filterWrites).toEqual([
      ["authors", ["a1"]],
      ["languages", ["en"]],
    ])
    expect(t.stateOf()).toBe("done")
  })

  it("leaves the smart-library card confirmable when the user is not PRO", async () => {
    h.ensurePro.mockResolvedValue(false)
    const t = harness({
      kind: "configure_smart_library",
      id: ACT,
      filters: { authorIds: ["a1"] },
    } as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT)

    expect(filterWrites).toEqual([])
    expect(t.stateOf()).toBe("pending")
  })

  it("confirms an add-to-library card that the library accepted", async () => {
    const t = harness({
      kind: "add_to_library",
      id: ACT,
      url: "https://x/y",
      title: "Lecture",
      author: "Author",
    } as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT)

    expect(h.addByUrl).toHaveBeenCalledWith("https://x/y", {
      title: "Lecture",
      author: "Author",
    })
    expect(t.stateOf()).toBe("done")
  })

  it("leaves an add-to-library card confirmable after a paywall bounce", async () => {
    h.addByUrl.mockResolvedValue("paywalled")
    const t = harness({ kind: "add_to_library", id: ACT, url: "https://x/y" } as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT)

    expect(t.stateOf()).toBe("pending")
  })

  it("marks an add-to-library card errored when the library refused it", async () => {
    h.addByUrl.mockResolvedValue("failed")
    const t = harness({ kind: "add_to_library", id: ACT, url: "https://x/y" } as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT)

    expect(t.stateOf()).toBe("error")
  })

  it("confirms an action kind it has no side effect for", async () => {
    const t = harness({ kind: "open_settings", id: ACT } as unknown as ChatActionPayload)

    await t.actions.executeAction(MSG, ACT)

    expect(t.stateOf()).toBe("done")
  })

  it("keeps other actions on the same message untouched", async () => {
    const t = harness({ kind: "upgrade_to_pro", id: ACT } as ChatActionPayload, undefined)
    t.messages.value[0].actionStates = { other: "done" }

    await t.actions.executeAction(MSG, ACT)

    expect(t.messages.value[0].actionStates).toEqual({ other: "done", [ACT]: "done" })
  })
})

describe("useChatActions.recordInlineHintCooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "debug").mockImplementation(() => {})
  })

  it("stamps the cooldown against the proactive repo", async () => {
    const t = harness({ kind: "upgrade_to_pro", id: ACT } as ChatActionPayload)
    const payload = { kind: "upgrade_to_pro", id: ACT } as ChatActionPayload

    await t.actions.recordInlineHintCooldown(MSG, payload)

    const [args, ports] = h.recordInlineHintCooldownUC.mock.calls[0] as unknown as [
      { chatMessageId: string; payload: ChatActionPayload; now: Date },
      { proactiveState: IProactiveStateRepository },
    ]
    expect(args.chatMessageId).toBe(MSG)
    expect(args.payload).toBe(payload)
    expect(ports.proactiveState).toBe(t.proactive)
  })

  it("swallows a failed attach so the inline card survives", async () => {
    h.recordInlineHintCooldownUC.mockRejectedValue(new Error("repo missing"))
    const t = harness({ kind: "upgrade_to_pro", id: ACT } as ChatActionPayload)

    await expect(
      t.actions.recordInlineHintCooldown(MSG, {
        kind: "upgrade_to_pro",
        id: ACT,
      } as ChatActionPayload)
    ).resolves.toBeUndefined()
  })
})
