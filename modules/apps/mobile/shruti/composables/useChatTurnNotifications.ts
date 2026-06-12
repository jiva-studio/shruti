import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { useShruti } from "@shruti/shruti.js"
import { notificationIdFor } from "@shruti/proactive/hash.js"
import { emitNotify } from "@shruti/notifications/notifyEvents.js"
import {
  onTurnSettled,
  onTurnStarted,
  type TurnSettledEvent,
  type TurnStartedEvent,
} from "@shruti/chat/turnNotificationEvents.js"

// Conservative estimate of a chat turn's wall-clock (retrieval-heavy turns run
// 30-40s). The predictive notification is armed this far out so it still fires
// if the WebView is frozen mid-turn; a turn that settles while JS is alive
// cancels it first.
const PREDICTED_TURN_MS = 45_000

/**
 * Arms the chat "answer ready" notification:
 * - on SEND, schedules a PREDICTIVE future local notification — the only thing
 *   that can fire if the WebView is frozen before the turn finishes.
 * - on SETTLE (JS alive), cancels that predictive one and, for a successful
 *   turn, emits a notify intent so `useUserNotifier` surfaces it as a toast
 *   (foreground) or an immediate notification (background).
 *
 * Goes through the `@ports/app` notification port + the notify bus — never
 * Capacitor or a toast directly (that decision is the presenter's). Mounted
 * once by App.vue.
 */
export function useChatTurnNotifications(): void {
  const app = useShruti()
  const { t } = useI18n()
  let unsubs: Array<() => void> = []

  async function onStarted(e: TurnStartedEvent): Promise<void> {
    const permission = await app.notifications.checkPermission().catch(() => "denied" as const)
    if (permission !== "granted") return
    await app.notifications
      .schedule({
        id: notificationIdFor(e.assistantMessageId),
        title: t("notifications.chatAnswerReadyTitle"),
        body: t("notifications.chatAnswerReadyBody"),
        at: Date.now() + PREDICTED_TURN_MS,
        extra: { chatSessionId: e.sessionId },
      })
      .catch(() => undefined)
  }

  async function onSettled(e: TurnSettledEvent): Promise<void> {
    const id = notificationIdFor(e.assistantMessageId)
    // JS is alive — drop the predictive alarm; we know the real outcome now.
    await app.notifications.cancel(id).catch(() => undefined)
    if (!e.ok) return
    emitNotify({
      title: t("notifications.chatAnswerReadyTitle"),
      body: t("notifications.chatAnswerReadyBody"),
      sessionId: e.sessionId,
      notificationId: id,
      whenBackground: "notify",
    })
  }

  onMounted(() => {
    unsubs = [onTurnStarted((e) => void onStarted(e)), onTurnSettled((e) => void onSettled(e))]
  })

  onBeforeUnmount(() => {
    for (const fn of unsubs) fn()
    unsubs = []
  })
}
