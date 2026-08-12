import { computed, type ComputedRef } from "vue"
import { useChatStore, type ChatMessage } from "@shruti/stores/useChatStore.js"

/**
 * The cheap, always-on slice of a chat bubble's failure state: which
 * template branch to render and whether the actions row may offer Retry.
 *
 * Every bubble in the thread instantiates this, so it deliberately holds
 * nothing but four computeds over its own message plus the one store flag
 * (`chat.sending`) that gates retry. No i18n composer, no timers, no window
 * listeners, no notice classification — all of that lives in
 * `useChatFailureNotice`, which only mounts underneath `failedKind`
 * (see `ChatFailureNotice.vue`).
 */
export function useChatMessageStatus(opts: {
  message: () => ChatMessage
  isLast: () => boolean
  onRequestRetry: (messageId: string) => void
}): {
  failedKind: ComputedRef<boolean>
  /** i18n key for the inline "…truncated/stopped" suffix, or "" for none.
   *  Returned as a key (not a string) so this composable needs no i18n
   *  hookup of its own — the bubble already has a `t`. */
  errorSuffixKey: ComputedRef<string>
  truncatedRetryVisible: ComputedRef<boolean>
  canRetry: ComputedRef<boolean>
  onRetry: () => void
} {
  const { message, isLast } = opts
  const chat = useChatStore()

  const failedKind = computed<boolean>(() => {
    const e = message().error
    return !!(e && e.kind === "failed" && !message().streaming)
  })

  const truncatedRetryVisible = computed<boolean>(() => {
    const e = message().error
    return !!(e && e.kind === "truncated" && !message().streaming && isLast())
  })

  /** True iff the store is idle and this bubble is the last one. */
  const canRetry = computed<boolean>(() => isLast() && !chat.sending)

  const errorSuffixKey = computed<string>(() => {
    const e = message().error
    if (!e) return ""
    if (e.kind === "truncated") {
      if (e.reason === "turns") return "chat.errTruncatedTurns"
      // Only a real transport drop gets the "connection dropped" copy. A
      // server-reported failure mid-answer (`turn_timeout`, `agent_error`, …)
      // arrives as its own code and reads as a generic interruption — telling
      // someone their connection died when the agent timed out sends them
      // chasing their wifi.
      if (e.reason === "stream") return "chat.errTruncatedStream"
      return "chat.errTruncatedError"
    }
    if (e.kind === "stopped") return "chat.errStopped"
    return ""
  })

  function onRetry(): void {
    if (!canRetry.value) return
    opts.onRequestRetry(message().id)
  }

  return { failedKind, errorSuffixKey, truncatedRetryVisible, canRetry, onRetry }
}
