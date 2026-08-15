import { describe, expect, it } from "vitest"
import { classifyChatNotice, type ChatNoticeInput } from "../chatNotice.js"

const base: ChatNoticeInput = {
  code: "rate_limited",
  tier: undefined,
  isOffline: false,
  isUnknownTier: false,
  quotaExpired: false,
  retryAllowed: true,
}

describe("classifyChatNotice", () => {
  it("returns a stable no-notice default when the message isn't a failure", () => {
    expect(classifyChatNotice({ ...base, code: null })).toEqual({
      kind: "error",
      titleKey: null,
      bodyKey: null,
      cta: "none",
    })
  })

  it("offline network failure → calm info + retry", () => {
    expect(classifyChatNotice({ ...base, code: "network", isOffline: true })).toEqual({
      kind: "info",
      titleKey: "chat.errOffline.title",
      bodyKey: "chat.errOffline.body",
      cta: "retry",
    })
  })

  it("chat_unavailable → info + retry (own title/body)", () => {
    expect(classifyChatNotice({ ...base, code: "chat_unavailable" })).toMatchObject({
      kind: "info",
      titleKey: "chat.errUnavailable.title",
      cta: "retry",
    })
  })

  it("http_5xx → error with server title/body, retryable", () => {
    expect(classifyChatNotice({ ...base, code: "http_503" })).toEqual({
      kind: "error",
      titleKey: "chat.errServer.title",
      bodyKey: "chat.errServer.body",
      cta: "retry",
    })
  })

  // #1843: a thrown 5xx carries no status, but it is still the backend's
  // fault — it must read as a server error rather than fall through to the
  // generic branch (which would show `errUnknown`).
  it("server_unreachable → same server title/body as a 5xx response", () => {
    expect(classifyChatNotice({ ...base, code: "server_unreachable" })).toEqual({
      kind: "error",
      titleKey: "chat.errServer.title",
      bodyKey: "chat.errServer.body",
      cta: "retry",
    })
  })

  it("generic failure → plain error, no title, failed-text body fallback, retry", () => {
    expect(classifyChatNotice({ ...base, code: "agent_error" })).toEqual({
      kind: "error",
      titleKey: null,
      bodyKey: null,
      cta: "retry",
    })
  })

  it("non-retryable codes (auth/protocol) → no cta", () => {
    expect(classifyChatNotice({ ...base, code: "http_401", retryAllowed: false }).cta).toBe("none")
    expect(
      classifyChatNotice({ ...base, code: "protocol_version_required", retryAllowed: false }).cta
    ).toBe("none")
  })

  it("rate_limited anonymous → upsell + sign-in CTA", () => {
    expect(classifyChatNotice({ ...base, tier: "anonymous" })).toEqual({
      kind: "upsell",
      titleKey: "chat.errQuotaAnonTitle",
      bodyKey: "chat.errQuotaAnonBody",
      cta: "signin",
    })
  })

  it("rate_limited free → upsell + upgrade CTA", () => {
    expect(classifyChatNotice({ ...base, tier: "free" })).toMatchObject({
      kind: "upsell",
      cta: "upgrade",
    })
  })

  it("rate_limited pro → warning, no CTA (just wait)", () => {
    expect(classifyChatNotice({ ...base, tier: "pro" })).toEqual({
      kind: "warning",
      titleKey: "chat.errQuotaProTitle",
      bodyKey: "chat.errQuotaProBody",
      cta: "none",
    })
  })

  it("rate_limited unknown tier → warning, generic body, no CTA", () => {
    expect(classifyChatNotice({ ...base, isUnknownTier: true, tier: undefined })).toEqual({
      kind: "warning",
      titleKey: "chat.errQuotaUnknownTitle",
      bodyKey: "chat.errQuotaUnknownBody",
      cta: "none",
    })
  })

  it("rate_limited with no tier from the server → upsell fallback, no title/cta", () => {
    expect(classifyChatNotice({ ...base, tier: undefined })).toEqual({
      kind: "upsell",
      titleKey: null,
      bodyKey: null,
      cta: "none",
    })
  })

  it("offline wins over a rate_limited code", () => {
    expect(classifyChatNotice({ ...base, tier: "free", isOffline: true }).kind).toBe("info")
  })

  /* Issue #1609: `rate_limited` never reached the `retry` CTA, so the
   * `failedRetryEnabled` deadline flip in useChatFailureNotice was
   * unreachable — the card offered an upsell for a limit that had already
   * lifted, and nothing on it re-asked the question. */
  describe("a quota window that has already rolled over", () => {
    it("offers Retry instead of an upsell for an expired anonymous quota", () => {
      expect(classifyChatNotice({ ...base, tier: "anonymous", quotaExpired: true })).toEqual({
        kind: "info",
        titleKey: null,
        bodyKey: null,
        cta: "retry",
      })
    })

    it("offers Retry for an expired free quota too", () => {
      expect(classifyChatNotice({ ...base, tier: "free", quotaExpired: true }).cta).toBe("retry")
    })

    it("gives a pro user — who has no other CTA at all — the deadline escape", () => {
      expect(classifyChatNotice({ ...base, tier: "pro", quotaExpired: true }).cta).toBe("retry")
    })

    it("gives an unrecognised tier the same escape", () => {
      expect(
        classifyChatNotice({ ...base, tier: undefined, isUnknownTier: true, quotaExpired: true })
          .cta
      ).toBe("retry")
    })

    it("does not fire for a non-quota failure", () => {
      // `quotaExpired` is only ever true for a 429; a stray true must not
      // rewrite an http_5xx notice.
      expect(classifyChatNotice({ ...base, code: "http_503", quotaExpired: true })).toMatchObject({
        titleKey: "chat.errServer.title",
      })
    })

    it("still upsells while the window is open", () => {
      expect(classifyChatNotice({ ...base, tier: "anonymous", quotaExpired: false }).cta).toBe(
        "signin"
      )
    })
  })
})
