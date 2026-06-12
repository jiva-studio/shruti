import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { App as CapApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import { toastController } from "@ionic/vue"
import { useShruti } from "@shruti/shruti.js"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import router from "@shruti/router/index.js"
import { onNotify, type NotifyIntent } from "@shruti/notifications/notifyEvents.js"

/**
 * The single place that decides HOW to surface a user notification:
 * - FOREGROUND → a top toast (a local OS notification would be redundant /
 *   annoying while the user is in the app); skipped entirely if they're already
 *   viewing that session, since the content is on screen.
 * - BACKGROUND → an immediate local notification, unless the intent's emitter
 *   owns its own background delivery (`whenBackground: "skip"`, e.g. proactive).
 *
 * Both chat-turn-ready and proactive-message-appeared route their intents here
 * via the notify bus, so the toast-vs-notification choice lives in one layer.
 * Native lifecycle (`@capacitor/app`) and presentation (toast / router) belong
 * in this composable, never in the store. Mounted once by App.vue.
 */
export function useUserNotifier(): void {
  const app = useShruti()
  const chat = useChatStore()
  const { t } = useI18n()

  let isForeground = true
  let stateHandle: PluginListenerHandle | null = null
  let unsubscribe: (() => void) | null = null

  async function showToast(intent: NotifyIntent): Promise<void> {
    const toast = await toastController.create({
      message: intent.body,
      duration: 4000,
      position: "top",
      buttons: intent.sessionId
        ? [
            {
              text: t("notifications.openButton"),
              handler: () => {
                void router.replace({ name: "chat", query: { session: intent.sessionId } })
              },
            },
          ]
        : [],
    })
    await toast.present()
  }

  async function presentBackgroundNotification(intent: NotifyIntent): Promise<void> {
    const permission = await app.notifications.checkPermission().catch(() => "denied" as const)
    if (permission !== "granted") return
    await app.notifications
      .schedule({
        id: intent.notificationId ?? 1,
        title: intent.title,
        body: intent.body,
        // Slightly in the future so the platform reliably fires it "now".
        at: Date.now() + 200,
        extra: intent.sessionId ? { chatSessionId: intent.sessionId } : undefined,
      })
      .catch(() => undefined)
  }

  function present(intent: NotifyIntent): void {
    if (isForeground) {
      // Already looking at that session — the content is live on screen.
      if (intent.sessionId && chat.activeSessionId === intent.sessionId) return
      void showToast(intent)
    } else if (intent.whenBackground === "notify") {
      void presentBackgroundNotification(intent)
    }
  }

  onMounted(() => {
    unsubscribe = onNotify(present)
    void CapApp.getState()
      .then((state) => {
        isForeground = state.isActive
      })
      .catch(() => undefined)
    void CapApp.addListener("appStateChange", (state) => {
      isForeground = state.isActive
    })
      .then((handle) => {
        stateHandle = handle
      })
      .catch(() => undefined)
  })

  onBeforeUnmount(() => {
    unsubscribe?.()
    unsubscribe = null
    void stateHandle?.remove()
    stateHandle = null
  })
}
