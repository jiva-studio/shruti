import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { notificationIdFor } from "@shruti/proactive/hash.js"
import { emitNotify } from "@shruti/notifications/notifyEvents.js"
import { onTurnSettled, type TurnSettledEvent } from "@shruti/chat/turnNotificationEvents.js"

/**
 * Surfaces the chat "answer ready" notification when a turn settles, for the
 * case where the app's JS is still alive at settle time. On settle it emits a
 * single notify intent and `useUserNotifier` decides how to surface it: a toast
 * when foregrounded off the chat screen, exactly ONE immediate local
 * notification when backgrounded-but-alive.
 *
 * The case where the WebView is FROZEN before settle (the user left) is covered
 * separately by `useUserNotifier`, which pre-arms a forward OS notification at
 * turn START and lets it fire at the estimate. Both paths share the same id
 * (`notificationIdFor(assistantMessageId)`), so a live settle replaces/cancels
 * the pre-armed one — never a duplicate. Mounted once by App.vue.
 */
export function useChatTurnNotifications(): void {
  const { t } = useI18n()
  let unsubs: Array<() => void> = []

  function onSettled(e: TurnSettledEvent): void {
    if (!e.ok) return
    emitNotify({
      title: t("notifications.chatAnswerReadyTitle"),
      body: t("notifications.chatAnswerReadyBody"),
      sessionId: e.sessionId,
      notificationId: notificationIdFor(e.assistantMessageId),
      whenBackground: "notify",
    })
  }

  onMounted(() => {
    unsubs = [onTurnSettled(onSettled)]
  })

  onBeforeUnmount(() => {
    for (const fn of unsubs) fn()
    unsubs = []
  })
}
