import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { useNow } from "@vueuse/core"
import type { QuotaTier } from "@lib/domain"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import type { ChatMessage } from "./chatTypes.js"
import { outranksTier } from "./chatUsageSnapshot.js"
import type { ChatUsageChip, RateLimitUsage } from "./useChatUsageChip.js"

/**
 * Lockout for a 429 that carries neither a server-measured wait nor a reset
 * instant. This number is ours, not the server's, and sits behind both real
 * sources — a bare 429 would otherwise leave the composer open to earn another
 * one immediately.
 */
export const BARE_RATE_LIMIT_LOCKOUT_MS = 60_000

// Floor between two automatic re-sends. A lift can be wrong (clock skew, a
// server bucket that hasn't rolled over), and the re-send then earns a fresh
// 429 with a fresh deadline — a self-feeding loop without this. An entitlement
// gain bypasses it: a larger allowance is a new entitlement, not a re-try.
const QUOTA_RESEND_MIN_GAP_MS = 60_000

export interface ChatComposeLockDeps {
  usage: ChatUsageChip
  messages: Ref<ChatMessage[]>
  sending: Ref<boolean>
  /** Re-asks the question the limit swallowed; read lazily because the store defines it later. */
  retryLast: (messageId: string) => Promise<void>
}

/** The parts of a `rate_limited` turn error the lockout acts on. */
export interface RateLimitInfo extends RateLimitUsage {
  tier: string | undefined
}

export interface ChatComposeLock {
  composeBlockedUntil: Ref<number | null>
  isComposeBlocked: ComputedRef<boolean>
  applyRateLimit: (info: RateLimitInfo) => void
  resetComposeLock: () => void
}

/**
 * The composer's rate-limit lockout, and the re-send of the question a lifted
 * limit had swallowed.
 *
 * The deadline is device-clock and in-memory only: a cold restart drops it, so
 * a server-side limit change (admin reset, Redis flush) is reflected on the
 * next send instead of being shadowed by a stale persisted one.
 */
export function useChatComposeLock(deps: ChatComposeLockDeps): ChatComposeLock {
  const { usage, messages, sending } = deps

  const composeBlockedUntil = ref<number | null>(null)

  // Ticks every second while a consumer subscribes; @vueuse owns the timer.
  const now = useNow({ interval: 1000 })
  const isComposeBlocked = computed<boolean>(
    () => composeBlockedUntil.value !== null && now.value.getTime() < composeBlockedUntil.value
  )

  /**
   * Lock the composer until the server-side counter resets, so the user can't
   * queue requests that only earn another 429.
   */
  function applyRateLimit(info: RateLimitInfo): void {
    // A 429 decided against a stale JWT claim — token rotation lagging a
    // recent purchase — would arm a free-tier deadline against a paying user.
    // The next send carries the corrected claim, so skip this one.
    if (useAuthStore().isPro && info.tier === "free") return
    composeBlockedUntil.value = info.retryAfterAt
    usage.recordFromRateLimit(info)
  }

  function isRateLimitedBubble(m: ChatMessage): boolean {
    return m.role === "assistant" && m.error?.kind === "failed" && m.error.code === "rate_limited"
  }

  /** Tier the newest rate-limited bubble was rejected under, if the server named one. */
  function newestRateLimitedTier(): QuotaTier | undefined {
    const all = messages.value
    for (let i = all.length - 1; i >= 0; i--) {
      const err = all[i].error
      if (isRateLimitedBubble(all[i]) && err?.kind === "failed") return err.tier
    }
    return undefined
  }

  /**
   * Does the identity now in force outrank the tier that swallowed the
   * question? Only a gain may auto-resend: every other transition lands on an
   * allowance no larger than the one that already said no, and sign-out would
   * burn a fresh anonymous quota on a turn nobody asked for.
   */
  function hasEntitlementGain(): boolean {
    const from = newestRateLimitedTier()
    if (!from) return false
    const auth = useAuthStore()
    const to: QuotaTier = auth.isPro ? "pro" : auth.signedIn ? "free" : "anonymous"
    return outranksTier(to, from)
  }

  // Held from the instant a re-send is decided until its turn settles, so the
  // sweep runs once per lift. `sending` latches too late: one identity change
  // mutates userId, quotaId and signedIn in a single flush, and all three
  // watchers would otherwise sail past it and re-send the same question.
  let quotaResendInFlight = false
  let lastQuotaResendAt = 0

  /**
   * Drop the inline "limit exhausted" bubbles. The row is removed rather than
   * stripped of its error — an error-less failed bubble renders nothing while
   * still holding a screenful of scroll room as the tail slot.
   *
   * The newest one survives when it is being re-asked: `retryLast` owns it and
   * holds it on screen until the replacement turn's user message lands.
   * Returns whether a re-send was kicked off.
   */
  function clearRateLimitedBubbles(opts: { resend: boolean }): boolean {
    if (quotaResendInFlight) return false
    const all = messages.value
    let newestIdx = -1
    for (let i = all.length - 1; i >= 0; i--) {
      if (isRateLimitedBubble(all[i])) {
        newestIdx = i
        break
      }
    }
    if (newestIdx < 0) return false

    // Re-asking needs a prompt to re-ask and an idle store; without either,
    // every rate-limited row simply goes.
    const resend =
      opts.resend && !sending.value && all.slice(0, newestIdx).some((m) => m.role === "user")
    const keep = resend ? all[newestIdx].id : null
    messages.value = all.filter((m) => !isRateLimitedBubble(m) || m.id === keep)
    if (!resend || keep === null) return false

    quotaResendInFlight = true
    void deps
      .retryLast(keep)
      .catch((err) => {
        console.warn("chat: failed to re-send the question after the quota lifted", err)
      })
      .finally(() => {
        quotaResendInFlight = false
      })
    return true
  }

  /**
   * Void the lockout for an identity that no longer owns it — each identity
   * has its own server-side quota bucket. Releasing the lock is unconditional;
   * re-asking the swallowed question is not.
   */
  function resetComposeLock(): void {
    composeBlockedUntil.value = null
    void usage.hydrate(useAuthStore().quotaId)
    // Stamped only when a re-send really happened: this runs on every identity
    // settle, including the anonymous session minted at boot.
    if (clearRateLimitedBubbles({ resend: hasEntitlementGain() })) lastQuotaResendAt = Date.now()
  }

  // The error card must die at the same edge as the lockout, or it hangs
  // around after the composer is back with no explanation.
  watch(
    () => composeBlockedUntil.value !== null && now.value.getTime() >= composeBlockedUntil.value,
    (expired, wasExpired) => {
      if (!expired || wasExpired) return
      composeBlockedUntil.value = null
      const at = Date.now()
      const resend = at - lastQuotaResendAt >= QUOTA_RESEND_MIN_GAP_MS
      if (clearRateLimitedBubbles({ resend })) lastQuotaResendAt = at
    }
  )

  return { composeBlockedUntil, isComposeBlocked, applyRateLimit, resetComposeLock }
}
