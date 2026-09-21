import { computed, watch, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { useChatStore, type ChatMessage } from "@lectorium/stores/useChatStore.js"
import { useAnonymousSignInFlow } from "@lectorium/composables/useAnonymousSignInFlow.js"
import { useConnectivity } from "@lectorium/composables/useConnectivity.js"
import type { QuotaTier } from "@lib/domain/chatMessage.js"
import { reportError } from "@lectorium/services/monitoring/reportError.js"
import { classifyChatNotice } from "./chatNotice.js"
import { useCountdownTick } from "./useCountdownTick.js"
import { failedTextKey, resetWhenPhrase, retryWhenPhrase, type Phrase } from "./chatFailureText.js"

export interface ChatNoticeCta {
  label: string
  action: () => void
  disabled?: boolean
}

/**
 * Failure rendering for an assistant bubble that IS in a `failed` state: the
 * rate-limit countdown tick, offline/online differentiation with auto-retry,
 * and the InlineNotice descriptor. They share the reactive `now` tick and the
 * retry gating, so they live together.
 *
 * This is the expensive half of the old `useChatMessageStatus` — i18n, three
 * store hookups, a 1s interval and a dozen computeds. `ChatFailureNotice.vue`
 * instantiates it under `v-if`, so an ordinary thread pays none of it.
 */
export function useChatFailureNotice(opts: {
  message: () => ChatMessage
  isLast: () => boolean
  onRequestRetry: (messageId: string) => void
}): {
  noticeKind: ComputedRef<"error" | "warning" | "upsell" | "info">
  noticeTitle: ComputedRef<string>
  noticeBody: ComputedRef<string>
  noticeCta: ComputedRef<ChatNoticeCta | undefined>
} {
  const { message, isLast } = opts
  const { t } = useI18n()
  const chat = useChatStore()
  const paywall = usePaywallStore()
  const auth = useAuthStore()
  const { triggerSignIn } = useAnonymousSignInFlow()

  const now = useCountdownTick(() => {
    const e = message().error
    return e?.kind === "failed" && typeof e.retryAfterAt === "number" ? e.retryAfterAt : null
  })

  /* -- Offline vs server-error differentiation ------------------------ */

  function onReconnect(): void {
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

  const { isOffline } = useConnectivity({ onReconnect })

  const isOfflineFailure = computed<boolean>(() => {
    const e = message().error
    if (!e || e.kind !== "failed") return false
    if (e.code !== "network") return false
    return isOffline.value
  })

  /* -- Retry eligibility ---------------------------------------------- */

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

  /** `retryLast` deletes the turn before re-sending, and a locked composer
   *  would make that deletion permanent — so retry needs an idle store, an
   *  unlocked composer and the last bubble. */
  const canRetry = computed<boolean>(() => isLast() && !chat.sending && !chat.isComposeBlocked)

  function onRequestRetryGuarded(): void {
    if (!canRetry.value) return
    opts.onRequestRetry(message().id)
  }
  const onRetry = onRequestRetryGuarded

  function translate(phrase: Phrase): string {
    return t(phrase.key, phrase.params ?? {})
  }

  const failedText = computed<string>(() => {
    const e = message().error
    if (!e || e.kind !== "failed") return ""
    if (e.code !== "rate_limited" || typeof e.retryAfterAt !== "number") {
      return t(failedTextKey(e.code))
    }
    const remainingMs = e.retryAfterAt - now.value
    if (remainingMs <= 0) return t("chat.errRate")
    return t("chat.errRateAfter", {
      when: translate(retryWhenPhrase(remainingMs, e.retryAfterAt, now.value)),
    })
  })

  /* -- InlineNotice (quota + errors) ---------------------------------- */

  const failedError = computed(() => {
    const e = message().error
    return e && e.kind === "failed" ? e : null
  })

  /** The tier the copy is rendered against. `"free"` becomes `"pro"` when the
   *  local JWT already knows the user is Pro, because the server's 429 can
   *  echo `free` until the next token rotation. `anonymous` is not overridden. */
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

  // Logged once per notice so schema drift is greppable, not swallowed.
  watch(
    isUnknownQuotaTier,
    (unknown) => {
      if (!unknown) return
      reportError("chat-quota", new Error(`unknown quota tier: ${failedError.value?.tier}`))
    },
    { immediate: true }
  )

  /** The quota window has rolled over while the card was on screen —
   *  `now` ticks once a second until the deadline, so this flips live. */
  const isQuotaExpired = computed<boolean>(() => {
    const e = failedError.value
    if (!e || e.code !== "rate_limited") return false
    return typeof e.retryAfterAt === "number" && now.value >= e.retryAfterAt
  })

  // The kind/title/body/cta branching is the pure `classifyChatNotice`; this
  // composable only resolves the i18n keys, fills the rate-limit countdown,
  // and binds the cta kind to an action.
  const notice = computed(() =>
    classifyChatNotice({
      code: failedError.value?.code ?? null,
      tier: effectiveQuotaTier.value,
      isOffline: isOfflineFailure.value,
      isUnknownTier: isUnknownQuotaTier.value,
      quotaExpired: isQuotaExpired.value,
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
    if (!key) return failedText.value
    // The rate-limit tier bodies carry a `{ when }` reset countdown.
    const reset =
      failedError.value?.code === "rate_limited"
        ? resetWhenPhrase(failedError.value.retryAfterAt, now.value)
        : null
    return reset ? t(key, { when: translate(reset) }) : t(key)
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

  return { noticeKind, noticeTitle, noticeBody, noticeCta }
}
