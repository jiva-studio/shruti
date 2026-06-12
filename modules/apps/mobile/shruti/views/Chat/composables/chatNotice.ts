import type { QuotaTier } from "@lib/domain/chatMessage.js"

export type ChatNoticeKind = "error" | "warning" | "upsell" | "info"
export type ChatNoticeCtaKind = "retry" | "signin" | "upgrade" | "none"

export interface ChatNoticeInput {
  /** `failedError.code`, or null when the message isn't a `failed` error. */
  readonly code: string | null
  /** `effectiveQuotaTier` — the free→pro override is already applied by the
   *  caller — or undefined when the server didn't send a tier. */
  readonly tier: QuotaTier | undefined
  /** A network failure while the device is offline. */
  readonly isOffline: boolean
  /** A `rate_limited` error whose `tier` is a string we don't recognise. */
  readonly isUnknownTier: boolean
  /** Whether a plain retry is allowed (false for http_401/403/protocol). */
  readonly retryAllowed: boolean
}

export interface ChatNoticeClass {
  readonly kind: ChatNoticeKind
  /** i18n key for the title, or null → no title. */
  readonly titleKey: string | null
  /** i18n key for the body, or null → the caller falls back to `failedText`.
   *  The rate-limit tier bodies take a `{ when }` param the caller fills. */
  readonly bodyKey: string | null
  readonly cta: ChatNoticeCtaKind
}

/**
 * Pure classification of an assistant-bubble failure into the InlineNotice
 * descriptor (kind / title key / body key / cta kind). Extracted from
 * `useChatMessageStatus` so the dense tier-ladder + offline/server/quota
 * branching is unit-testable without a Vue mount harness. The composable
 * resolves the i18n keys, fills the rate-limit `{ when }` countdown, and maps
 * the `cta` kind to its action + disabled state.
 */
export function classifyChatNotice(input: ChatNoticeInput): ChatNoticeClass {
  const { code, tier, isOffline, isUnknownTier, retryAllowed } = input

  // Not a `failed` error → the bubble shows no notice. The caller guards on
  // this; return a stable default.
  if (code === null) {
    return { kind: "error", titleKey: null, bodyKey: null, cta: "none" }
  }

  // Offline network failure — calm, retryable.
  if (isOffline) {
    return {
      kind: "info",
      titleKey: "chat.errOffline.title",
      bodyKey: "chat.errOffline.body",
      cta: "retry",
    }
  }

  // Backend out of credits / provider down — not the user's fault and
  // transient, so calm (info) with a Retry.
  if (code === "chat_unavailable") {
    return {
      kind: "info",
      titleKey: "chat.errUnavailable.title",
      bodyKey: "chat.errUnavailable.body",
      cta: retryAllowed ? "retry" : "none",
    }
  }

  // Server not ready (5xx) — an error with its own title/body, retryable.
  if (code.startsWith("http_5")) {
    return {
      kind: "error",
      titleKey: "chat.errServer.title",
      bodyKey: "chat.errServer.body",
      cta: retryAllowed ? "retry" : "none",
    }
  }

  // Everything except a quota 429 is a plain error with no title; the body
  // falls back to `failedText` (null bodyKey).
  if (code !== "rate_limited") {
    return {
      kind: "error",
      titleKey: null,
      bodyKey: null,
      cta: retryAllowed ? "retry" : "none",
    }
  }

  // Quota 429 with a tier we don't recognise — warn, no CTA, body is generic.
  if (isUnknownTier) {
    return {
      kind: "warning",
      titleKey: "chat.errQuotaUnknownTitle",
      bodyKey: "chat.errQuotaUnknownBody",
      cta: "none",
    }
  }

  // Quota 429, known tier ladder.
  if (tier === "anonymous") {
    return {
      kind: "upsell",
      titleKey: "chat.errQuotaAnonTitle",
      bodyKey: "chat.errQuotaAnonBody",
      cta: "signin",
    }
  }
  if (tier === "free") {
    return {
      kind: "upsell",
      titleKey: "chat.errQuotaFreeTitle",
      bodyKey: "chat.errQuotaFreeBody",
      cta: "upgrade",
    }
  }
  if (tier === "pro") {
    return {
      kind: "warning",
      titleKey: "chat.errQuotaProTitle",
      bodyKey: "chat.errQuotaProBody",
      cta: "none",
    }
  }

  // rate_limited but the server sent no tier — warn-by-default (upsell is the
  // fallback kind), no title, body falls back to `failedText`, no CTA.
  return { kind: "upsell", titleKey: null, bodyKey: null, cta: "none" }
}
