import { describe, expect, it } from "vitest"
import { classifyChatNotice, type ChatNoticeInput } from "../chatNotice.js"

const base: ChatNoticeInput = {
  code: "rate_limited",
  tier: undefined,
  isOffline: false,
  isUnknownTier: false,
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
})
