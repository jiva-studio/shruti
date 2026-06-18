import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { useChatStore, type ChatMessage } from "@lectorium/stores/useChatStore.js"
import { useAnonymousSignInFlow } from "@lectorium/composables/useAnonymousSignInFlow.js"
import type { QuotaTier } from "@lib/domain/chatMessage.js"
import { reportError } from "@lectorium/services/monitoring/reportError.js"
import { classifyChatNotice } from "./chatNotice.js"

export interface ChatNoticeCta {
  label: string
  action: () => void
  disabled?: boolean
}

/**
 * Failure rendering for an assistant chat bubble: the rate-limit
 * countdown tick, offline/online differentiation + auto-retry, the
 * retry-eligibility predicates, and the InlineNotice descriptor
 * (kind/title/body/cta) for quota + error states. Extracted wholesale
 * from ChatMessageBubble — the failure and quota-notice concerns share
 * the reactive `now` tick and the retry gating, so they live in one
 * composable rather than being split apart and re-wired.
 */
export function useChatMessageStatus(opts: {
  message: () => ChatMessage
  isLast: () => boolean
  onRequestRetry: (messageId: string) => void
}): {
  failedKind: ComputedRef<boolean>
  errorSuffix: ComputedRef<string>
  truncatedRetryVisible: ComputedRef<boolean>
  canRetry: ComputedRef<boolean>
  noticeKind: ComputedRef<"error" | "warning" | "upsell" | "info">
  noticeTitle: ComputedRef<string>
  noticeBody: ComputedRef<string>
  noticeCta: ComputedRef<ChatNoticeCta | undefined>
  onRetry: () => void
} {
  const { message, isLast } = opts
  const { t } = useI18n()
  const chat = useChatStore()
  const paywall = usePaywallStore()
  const auth = useAuthStore()
  const { triggerSignIn } = useAnonymousSignInFlow()

  /* -- Countdown tick ------------------------------------------------- */

  /** Tick once per second while a `rate_limited` countdown is on the
   *  screen. Used to recompute `failedText` (counts down "in N s") and
   *  `failedRetryEnabled` (flips at the deadline). */
  const now = ref(Date.now())
  let tickHandle: ReturnType<typeof setInterval> | null = null

  function stopTick(): void {
    if (tickHandle !== null) {
      clearInterval(tickHandle)
      tickHandle = null
    }
  }

  // Drive the tick off `error.retryAfterAt`. Watching (not onMounted) so
  // a bubble that transitions from streaming → failed AFTER mount still
  // gets a live countdown.
  watch(
    () => {
      const e = message().error
      return e?.kind === "failed" && typeof e.retryAfterAt === "number" ? e.retryAfterAt : null
    },
    (retryAfterAt) => {
      stopTick()
      if (retryAfterAt === null) return
      now.value = Date.now()
      tickHandle = setInterval(() => {
        now.value = Date.now()
        if (now.value >= retryAfterAt) stopTick()
      }, 1000)
    },
    { immediate: true }
  )

  onBeforeUnmount(stopTick)

  /* -- Offline vs server-error differentiation ------------------------ */

  const isOffline = ref<boolean>(typeof navigator !== "undefined" && navigator.onLine === false)

  function onOnline(): void {
    isOffline.value = false
    // Auto-retry only when this is the last bubble, the failure was a
    // network failure, and the store is idle. Anything else we leave for
    // the user to drive.
    if (!isLast()) return
    const e = message().error
    if (!e || e.kind !== "failed") return
    if (e.code !== "network") return
    if (!canRetry.value) return
    onRequestRetryGuarded()
  }

  function onOffline(): void {
    isOffline.value = true
  }

  onMounted(() => {
    if (typeof window === "undefined") return
    window.addEventListener("online", onOnline)
    window.addEventListener("offline", onOffline)
  })

  onBeforeUnmount(() => {
    if (typeof window === "undefined") return
    window.removeEventListener("online", onOnline)
    window.removeEventListener("offline", onOffline)
  })

  const isOfflineFailure = computed<boolean>(() => {
    const e = message().error
    if (!e || e.kind !== "failed") return false
    if (e.code !== "network") return false
    return isOffline.value
  })

  /* -- Retry eligibility ---------------------------------------------- */

  const failedKind = computed<boolean>(() => {
    const e = message().error
    return !!(e && e.kind === "failed" && !message().streaming)
  })

  const failedRetryAllowed = computed<boolean>(() => {
    const e = message().error
    if (!e || e.kind !== "failed") return false
    return e.code !== "http_401" && e.code !== "http_403" && e.code !== "protocol_version_required"
  })

  const failedRetryEnabled = computed<boolean>(() => {
    const e = message().error
    if (!e || e.kind !== "failed") return false
    if (typeof e.retryAfterAt === "number") return now.value >= e.retryAfterAt
    return true
  })

  const truncatedRetryVisible = computed<boolean>(() => {
    const e = message().error
    return !!(e && e.kind === "truncated" && !message().streaming && isLast())
  })

  /** True iff the store is idle and this bubble is the last one. */
  const canRetry = computed<boolean>(() => isLast() && !chat.sending)

  function onRequestRetryGuarded(): void {
    if (!canRetry.value) return
    opts.onRequestRetry(message().id)
  }
  const onRetry = onRequestRetryGuarded

  const errorSuffix = computed<string>(() => {
    const e = message().error
    if (!e) return ""
    if (e.kind === "truncated") {
      return e.reason === "turns" ? t("chat.errTruncatedTurns") : t("chat.errTruncatedStream")
    }
    if (e.kind === "stopped") return t("chat.errStopped")
    return ""
  })

  const failedText = computed<string>(() => {
    const e = message().error
    if (!e || e.kind !== "failed") return ""
    if (e.code === "rate_limited") {
      if (typeof e.retryAfterAt === "number") {
        const remainingMs = e.retryAfterAt - now.value
        if (remainingMs > 0) {
          return t("chat.errRateAfter", { when: formatRetryWhen(remainingMs, e.retryAfterAt) })
        }
      }
      return t("chat.errRate")
    }
    if (e.code === "max_turns_exceeded") return t("chat.errMaxTurns")
    if (e.code === "chat_unavailable") return t("chat.errUnavailable.body")
    if (e.code === "agent_error") return t("chat.errAgent")
    if (e.code === "http_401" || e.code === "http_403") return t("chat.errAuth")
    if (e.code === "protocol_version_required") return t("chat.errProtocol")
    if (e.code.startsWith("http_5")) return t("chat.errServiceNotReady")
    if (e.code === "network") return t("chat.errNetwork")
    if (e.code === "stream") return t("chat.errStreamDropped")
    return t("chat.errUnknown")
  })

  /**
   * Format a "{when}" fragment for `errRateAfter`:
   *  - < 60s → "in N s"; < 1h → "in N min"; else "at HH:MM" /
   *    "tomorrow at HH:MM" (disambiguated against the local day, since
   *    the server resets at UTC midnight).
   */
  function formatRetryWhen(remainingMs: number, deadlineMs: number): string {
    const seconds = Math.ceil(remainingMs / 1000)
    if (seconds < 60) return t("chat.retryInSeconds", { n: seconds })
    if (seconds < 60 * 60) {
      const minutes = Math.ceil(seconds / 60)
      return t("chat.retryInMinutes", { n: minutes })
    }
    const d = new Date(deadlineMs)
    const hh = d.getHours().toString().padStart(2, "0")
    const mm = d.getMinutes().toString().padStart(2, "0")
    const time = `${hh}:${mm}`
    const nowD = new Date(now.value)
    const sameLocalDay =
      d.getFullYear() === nowD.getFullYear() &&
      d.getMonth() === nowD.getMonth() &&
      d.getDate() === nowD.getDate()
    return sameLocalDay ? t("chat.retryAtTime", { time }) : t("chat.retryAtTimeTomorrow", { time })
  }

  /** Reset-time helper for the quota body strings. Reads the reactive
   *  `now` so the body re-renders every second while counting down. */
  function formatResetWhen(retryAfterAt: number | undefined): string {
    if (typeof retryAfterAt !== "number") return ""
    const remainingMs = retryAfterAt - now.value
    if (remainingMs <= 0) return t("chat.retryNow")
    return formatRetryWhen(remainingMs, retryAfterAt)
  }

  /* -- InlineNotice (quota + errors) ---------------------------------- */

  const failedError = computed(() => {
    const e = message().error
    return e && e.kind === "failed" ? e : null
  })

  /** Tier we render copy against. Overrides `"free"` → `"pro"` when the
   *  local JWT already knows the user is Pro (the server's 429 can
   *  transiently echo `free` until the next token rotation — issue
   *  #718). The `anonymous` echo is intentionally NOT overridden. */
  const effectiveQuotaTier = computed<QuotaTier | undefined>(() => {
    const tier = failedError.value?.tier
    if (auth.isPro && tier === "free") return "pro"
    return tier
  })

  /** Recognised quota tiers — keep in sync with `QuotaTier`. */
  const KNOWN_TIERS = new Set(["anonymous", "free", "pro"])

  const isUnknownQuotaTier = computed<boolean>(() => {
    const e = failedError.value
    if (!e || e.code !== "rate_limited") return false
    if (typeof e.tier !== "string") return false
    return !KNOWN_TIERS.has(e.tier)
  })

  // Log once per bubble when we hit the unknown-tier path so schema
  // drift is greppable instead of silently swallowed.
  watch(
    isUnknownQuotaTier,
    (unknown) => {
      if (!unknown) return
      reportError("chat-quota", new Error(`unknown quota tier: ${failedError.value?.tier}`))
    },
    { immediate: true }
  )

  // The kind/title/body/cta branching is the pure `classifyChatNotice`; this
  // composable only resolves the i18n keys, fills the rate-limit countdown,
  // and binds the cta kind to an action.
  const notice = computed(() =>
    classifyChatNotice({
      code: failedError.value?.code ?? null,
      tier: effectiveQuotaTier.value,
      isOffline: isOfflineFailure.value,
      isUnknownTier: isUnknownQuotaTier.value,
      retryAllowed: failedRetryAllowed.value,
    })
  )

  const noticeKind = computed<"error" | "warning" | "upsell" | "info">(() => notice.value.kind)

  const noticeTitle = computed<string>(() => {
    const key = notice.value.titleKey
    return key ? t(key) : ""
  })

  const noticeBody = computed<string>(() => {
    const key = notice.value.bodyKey
    if (!key) return failedText.value // generic / non-quota → the failed text
    // The rate-limit tier bodies carry a `{ when }` reset countdown.
    if (failedError.value?.code === "rate_limited") {
      return t(key, { when: formatResetWhen(failedError.value.retryAfterAt) })
    }
    return t(key)
  })

  const noticeCta = computed<ChatNoticeCta | undefined>(() => {
    switch (notice.value.cta) {
      case "none":
        return undefined
      case "signin":
        return {
          label: t("chat.signInForMoreCta"),
          action: () => {
            void triggerSignIn()
          },
        }
      case "upgrade":
        return { label: t("chat.upgradeToProCta"), action: () => paywall.requestOpen("chat") }
      case "retry":
        return isOfflineFailure.value
          ? {
              label: t("chat.errOffline.cta"),
              action: onRetry,
              disabled: !canRetry.value || isOffline.value,
            }
          : {
              label: t("chat.actionRetry"),
              action: onRetry,
              disabled: !failedRetryEnabled.value || !canRetry.value,
            }
      default:
        return undefined
    }
  })

  return {
    failedKind,
    errorSuffix,
    truncatedRetryVisible,
    canRetry,
    noticeKind,
    noticeTitle,
    noticeBody,
    noticeCta,
    onRetry,
  }
}
