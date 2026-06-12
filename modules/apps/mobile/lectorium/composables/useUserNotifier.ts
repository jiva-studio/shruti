import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { App as CapApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import { toastController } from "@ionic/vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useChatStore } from "@lectorium/stores/useChatStore.js"
import { notificationIdFor } from "@lectorium/proactive/hash.js"
import router from "@lectorium/router/index.js"
import { onNotify, type NotifyIntent } from "@lectorium/notifications/notifyEvents.js"
import { onTurnSettled, onTurnStarted } from "@lectorium/chat/turnNotificationEvents.js"

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
  const app = useLectorium()
  const chat = useChatStore()
  const { t } = useI18n()

  let isForeground = true
  let stateHandle: PluginListenerHandle | null = null
  let unsubscribe: (() => void) | null = null
  let turnUnsubs: Array<() => void> = []

  // A local notification is BUILT by JS at answer-completion time — but the
  // WebView's JS is frozen while the app is backgrounded, so that code never
  // runs and nothing fires. The fix (no push): arm the OS notification AHEAD,
  // at turn START, while the app is unquestionably alive with time to spare.
  // It fires near the estimated completion, so the user who left gets alerted.
  // To stop it firing while the user IS present, it's cancelled on settle AND
  // whenever the app comes to the foreground (and re-armed if they leave
  // again) — see `reconcileForwardNotifications`. Keyed by the SAME id as the
  // settle path (`notificationIdFor(assistantMessageId)`), so arm/cancel/replace
  // can never produce a duplicate. Estimate sits comfortably above the typical
  // 30–40s turn so a foreground turn settles (and cancels) before it fires.
  const TURN_ESTIMATE_MS = 60_000

  type PendingTurn = {
    readonly assistantMessageId: string
    readonly sessionId: string
    readonly createdAt: number
  }

  /** "Answer ready" notification title: the session's own title when it has
   *  one (so multiple chats are distinguishable in the shade), else the generic
   *  "Sadhu replied". */
  function answerTitle(sessionId: string | undefined): string {
    const titled = sessionId ? chat.sessionTitleFor(sessionId) : null
    return titled ?? t("notifications.chatAnswerReadyTitle")
  }

  /** Schedule (or replace) the forward notification for one pending turn, to
   *  fire near its estimated completion. */
  async function armForward(p: PendingTurn): Promise<void> {
    const permission = await app.notifications.checkPermission().catch(() => "denied" as const)
    if (permission !== "granted") return
    await app.notifications
      .schedule({
        id: notificationIdFor(p.assistantMessageId),
        title: answerTitle(p.sessionId),
        body: t("notifications.chatAnswerReadyBody"),
        at: Math.max(Date.now() + 2_000, p.createdAt + TURN_ESTIMATE_MS),
        extra: { chatSessionId: p.sessionId },
      })
      .catch(() => undefined)
  }

  async function cancelForward(assistantMessageId: string): Promise<void> {
    await app.notifications.cancel(notificationIdFor(assistantMessageId)).catch(() => undefined)
  }

  /** Keep the OS forward-notifications consistent with "is the app in front?":
   *  - FOREGROUND → cancel every pending turn's forward notif. In-app surfacing
   *    (toast on settle) covers it; this is what stops a notification firing
   *    while the user sits watching the thinking indicator after coming back.
   *  - BACKGROUND → (re)arm one per pending turn, so a frozen WebView still
   *    alerts even if they leave again. Idempotent (same id → schedule replaces,
   *    cancel removes), so calling this on every app-state flip is safe. */
  async function reconcileForwardNotifications(): Promise<void> {
    const pending = await chat.listPendingTurns().catch(() => [] as PendingTurn[])
    for (const p of pending) {
      if (isForeground) void cancelForward(p.assistantMessageId)
      else void armForward(p)
    }
  }

  /** Short "incoming message" notification sound — a bundled audio asset
   *  (`public/sounds/notify.mp3`, Mixkit free-license SFX), NOT synthesized.
   *  Silent if autoplay is blocked / the file is unavailable. */
  function playChime(): void {
    try {
      const audio = new Audio("/sounds/notify.mp3")
      audio.volume = 0.6
      void audio.play().catch(() => undefined)
    } catch {
      // audio unavailable / autoplay blocked — silent
    }
  }

  async function showToast(intent: NotifyIntent): Promise<void> {
    const header =
      (intent.sessionId ? chat.sessionTitleFor(intent.sessionId) : null) ?? intent.title
    const toast = await toastController.create({
      header,
      message: intent.body,
      color: "primary",
      duration: 6500,
      position: "top",
    })
    // The WHOLE toast is tappable (no separate "Open" button) — tap opens the
    // session, same as a notification tap.
    if (intent.sessionId !== undefined) {
      toast.style.cursor = "pointer"
      toast.addEventListener("click", () => {
        void router.replace({ name: "chat", query: { session: intent.sessionId } })
        void toast.dismiss()
      })
    }
    playChime()
    await toast.present()
  }

  async function presentBackgroundNotification(intent: NotifyIntent): Promise<void> {
    const permission = await app.notifications.checkPermission().catch(() => "denied" as const)
    if (permission !== "granted") return
    await app.notifications
      .schedule({
        id: intent.notificationId ?? 1,
        // Prefer the session's own title (distinguishable in the shade); fall
        // back to the intent's generic title for non-chat / untitled sessions.
        title: answerTitle(intent.sessionId),
        body: intent.body,
        // Slightly in the future so the platform reliably fires it "now".
        at: Date.now() + 200,
        extra: intent.sessionId ? { chatSessionId: intent.sessionId } : undefined,
      })
      .catch(() => undefined)
  }

  function present(intent: NotifyIntent): void {
    // Actually looking at THIS session's thread right now? Then its content is
    // live on screen — surface nothing. Gate on the real route's `?session=`
    // param, NOT `activeSessionId` (which stays set after the user navigates to
    // the session list or another tab, wrongly suppressing the toast app-wide).
    const viewingThisSession =
      isForeground &&
      intent.sessionId !== undefined &&
      router.currentRoute.value.name === "chat" &&
      router.currentRoute.value.query.session === intent.sessionId

    if (isForeground) {
      // The turn settled in-app: the pre-armed forward OS notification must
      // not fire later. Cancel it here (nothing reschedules it in the
      // foreground path, so there's no cancel-vs-schedule race). The
      // background branch deliberately does NOT cancel — it RE-SCHEDULES the
      // same id to fire immediately, which replaces the forward one.
      if (intent.whenBackground === "notify" && intent.notificationId !== undefined) {
        void app.notifications.cancel(intent.notificationId).catch(() => undefined)
      }
      if (viewingThisSession) return
      void showToast(intent)
    } else if (intent.whenBackground === "notify") {
      void presentBackgroundNotification(intent)
    }

    // A chat reply (whenBackground "notify") that arrived while the user
    // wasn't viewing it also marks the dialog unread — lighting the per-
    // session dot + tab/launcher badge. Proactive intents ("skip") are
    // already tracked as unseen via proactive_state, so they're left alone.
    if (intent.whenBackground === "notify" && intent.sessionId !== undefined) {
      void chat.markAnswerUnread(intent.sessionId)
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
      // Reconcile on every flip: leaving arms pending turns, returning cancels
      // them so nothing fires while the user is watching.
      void reconcileForwardNotifications()
    })
      .then((handle) => {
        stateHandle = handle
      })
      .catch(() => undefined)

    // Pre-arm the forward notification when a turn starts (app is alive now).
    // On a SUCCESSFUL settle the cancel/replace is handled inside `present`
    // (the notify bus), race-free. Here we only cancel on a FAILED/stopped
    // settle — no "answer ready" intent is emitted for those, so the pre-armed
    // notification would otherwise lie and fire at the estimate.
    turnUnsubs = [
      onTurnStarted(
        (e) =>
          void armForward({
            assistantMessageId: e.assistantMessageId,
            sessionId: e.sessionId,
            createdAt: Date.now(),
          })
      ),
      onTurnSettled((e) => {
        if (!e.ok) void cancelForward(e.assistantMessageId)
      }),
    ]
  })

  onBeforeUnmount(() => {
    unsubscribe?.()
    unsubscribe = null
    void stateHandle?.remove()
    stateHandle = null
    for (const fn of turnUnsubs) fn()
    turnUnsubs = []
  })
}
