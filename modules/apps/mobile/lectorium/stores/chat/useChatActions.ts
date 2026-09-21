import type { Ref } from "vue"
import type { ChatActionPayload, ChatActionState, SmartLibraryFiltersPayload } from "@lib/domain"
import type { ChatMessageId, TrackId } from "@lib/domain/core.js"
import type { IChatMessageRepository, IProactiveStateRepository } from "@lib/domain/ports/index.js"
import type { INotificationScheduler } from "@ports/app/index.js"
import { recordInlineHintCooldown as recordInlineHintCooldownUC } from "@usecases"
import { applyDailyReminder } from "@lectorium/composables/useDailyReminder.js"
import type { ChatMessage } from "./chatTypes.js"

/**
 * What an action's side effect accomplished. Returning normally cannot stand
 * in for success: a PRO gate bounces the user to the paywall and comes back,
 * which must leave the card confirmable rather than an inert checkmark.
 *   - `applied`  — the effect happened → `done`
 *   - `deferred` — nothing happened, the user may act and retry → `pending`
 *   - `failed`   — the effect was attempted and refused → `error`
 */
export type ActionOutcome = "applied" | "deferred" | "failed"

const ACTION_STATE_FOR_OUTCOME: Record<ActionOutcome, ChatActionState> = {
  applied: "done",
  deferred: "pending",
  failed: "error",
}

export interface ChatActionsDeps {
  messages: Ref<ChatMessage[]>
  chatMessages: () => IChatMessageRepository
  proactiveState: () => IProactiveStateRepository
  notifications: INotificationScheduler
  addToQueue: (trackId: TrackId) => Promise<{ ok: boolean; error?: string }>
  t: (key: string) => string
}

export interface ChatActions {
  executeAction: (
    messageId: string,
    actionId: string,
    override?: { time?: string }
  ) => Promise<void>
  recordInlineHintCooldown: (chatMessageId: string, payload: ChatActionPayload) => Promise<void>
}

/** The inline action cards an answer can carry, and what confirming one does. */
export function useChatActions(deps: ChatActionsDeps): ChatActions {
  const { messages } = deps

  async function setActionState(
    messageId: string,
    actionId: string,
    state: ChatActionState
  ): Promise<void> {
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const prev = messages.value[idx]
    const actionStates = { ...(prev.actionStates ?? {}), [actionId]: state }
    const next = [...messages.value]
    next[idx] = { ...prev, actionStates }
    messages.value = next
    try {
      await deps.chatMessages().updateActionStates(messageId as ChatMessageId, actionStates)
    } catch (err) {
      console.warn("chat: failed to persist action state", err)
    }
  }

  // `<messageId>\0<actionId>` keys whose run is mid-flight, claimed
  // synchronously: the persisted "executing" flip awaits a SQLite write, and a
  // second tap inside that window would otherwise run the side effect twice.
  const inFlightActions = new Set<string>()

  async function executeAction(
    messageId: string,
    actionId: string,
    override?: { time?: string }
  ): Promise<void> {
    const msg = messages.value.find((m) => m.id === messageId)
    const action = msg?.actions?.[actionId]
    if (!action || isSettled(msg?.actionStates?.[actionId])) return

    const lockKey = `${messageId}\0${actionId}`
    if (inFlightActions.has(lockKey)) return
    inFlightActions.add(lockKey)

    await setActionState(messageId, actionId, "executing")
    try {
      const outcome = await runAction(action, override)
      await setActionState(messageId, actionId, ACTION_STATE_FOR_OUTCOME[outcome])
    } catch (err) {
      console.warn("chat: action execution failed", err)
      await setActionState(messageId, actionId, "error")
    } finally {
      inFlightActions.delete(lockKey)
    }
  }

  function isSettled(state: ChatActionState | undefined): boolean {
    return state === "executing" || state === "done"
  }

  async function runAction(
    action: ChatActionPayload,
    override?: { time?: string }
  ): Promise<ActionOutcome> {
    switch (action.kind) {
      case "enable_daily_reminder":
        // The card lets the user pick a time before confirming; if they did,
        // the chosen value rides in on `override`.
        await applyDailyReminderAt(override?.time ?? action.time)
        return "applied"
      case "configure_smart_library":
        return await applySmartLibrary(action.filters)
      case "upgrade_to_pro": {
        const { usePaywallStore } = await import("@lectorium/stores/usePaywallStore.js")
        usePaywallStore().requestOpen()
        return "applied"
      }
      case "queue_next_track": {
        const r = await deps.addToQueue(action.trackId as TrackId)
        if (!r.ok && r.error !== "already-in-playlist") {
          throw new Error(`queue next failed: ${r.error}`)
        }
        return "applied"
      }
      case "add_to_library":
        return await applyAddToLibrary(action)
      default:
        return "applied"
    }
  }

  /**
   * Mirrors the Settings binding: persist the prefs the user-facing toggle
   * reads from, then re-arm the alarm. Bounded HH:mm — an unbounded form
   * accepts `25:99` and throws downstream in `setHours`.
   */
  async function applyDailyReminderAt(time: string): Promise<void> {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time)
    if (!m) throw new Error(`enable_daily_reminder: invalid time '${time}'`)
    const { useConfig } = await import("@lectorium/composables/useConfig.js")
    const enabled = useConfig<boolean>("settings.notificationsEnabled", false)
    const timeRef = useConfig<[number, number] | undefined>("settings.notificationsTime", undefined)
    enabled.value = true
    timeRef.value = [Number(m[1]), Number(m[2])]
    await applyDailyReminder(
      {
        enabled: true,
        time,
        title: deps.t("app.title"),
        body: deps.t("notifications.timeToListen"),
      },
      { notifications: deps.notifications }
    )
  }

  async function applySmartLibrary(filters: SmartLibraryFiltersPayload): Promise<ActionOutcome> {
    const { usePurchasesStore } = await import("@lectorium/stores/usePurchasesStore.js")
    // `ensurePro` waits out the entitlement reconcile and opens the paywall
    // itself when the answer is no. Reported as `deferred` so the card stays
    // confirmable — re-tapping it after the upgrade is the intended path, and
    // a `done` card cannot be tapped.
    if (!(await usePurchasesStore().ensurePro("smartLibrary"))) return "deferred"
    const { useAutoDownloadFiltersStore } =
      await import("@lectorium/stores/useAutoDownloadFiltersStore.js")
    const store = useAutoDownloadFiltersStore()
    await store.load()
    if (filters.authorIds) await store.setAuthors(filters.authorIds)
    if (filters.tagIds) await store.setTags(filters.tagIds)
    if (filters.sourceIds) await store.setSources(filters.sourceIds)
    if (filters.locationIds) await store.setLocations(filters.locationIds)
    if (filters.languageCodes) await store.setLanguages(filters.languageCodes)
    return "applied"
  }

  /**
   * Chat is discovery only and never ingests: the submit goes through the
   * library store, which PRO-gates it and bounces a non-subscriber to the
   * paywall. That bounce is the designed path, so its outcome is reported
   * rather than swallowed — the card must stay tappable for a user who then
   * subscribes.
   */
  async function applyAddToLibrary(
    action: Extract<ChatActionPayload, { kind: "add_to_library" }>
  ): Promise<ActionOutcome> {
    const { useLibraryStore } = await import("@lectorium/stores/useLibraryStore.js")
    // The candidate's title/author ride along as hints so the pre-ready card
    // shows a real title rather than "Untitled".
    const result = await useLibraryStore().addByUrl(action.url, {
      title: action.title,
      author: action.author ?? undefined,
    })
    if (result === "paywalled") return "deferred"
    return result === "added" ? "applied" : "failed"
  }

  /** Best-effort: a failed attach still leaves the user the inline card. */
  async function recordInlineHintCooldown(
    chatMessageId: string,
    payload: ChatActionPayload
  ): Promise<void> {
    try {
      await recordInlineHintCooldownUC(
        { chatMessageId: chatMessageId as ChatMessageId, payload, now: new Date() },
        { proactiveState: deps.proactiveState() }
      )
    } catch (err) {
      console.debug("[proactive] inline hint attach failed:", err)
    }
  }

  return { executeAction, recordInlineHintCooldown }
}
