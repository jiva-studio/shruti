import { describe, expect, it } from "vitest"
import { EmailOtpError } from "@ports/app/auth.js"
import { emailOtpErrorKey } from "../emailOtpErrorKey.js"

describe("emailOtpErrorKey", () => {
  it("names each known failure", () => {
    expect(emailOtpErrorKey(new EmailOtpError("invalid-email"))).toBe(
      "settings.account.email.errors.invalidEmail"
    )
    expect(emailOtpErrorKey(new EmailOtpError("throttled"))).toBe(
      "settings.account.email.errors.throttled"
    )
  })

  it("falls back to the generic message for an unknown kind", () => {
    expect(emailOtpErrorKey(new EmailOtpError("teapot" as never))).toBe(
      "settings.account.email.errors.generic"
    )
  })

  it("falls back for anything that is not an OTP error", () => {
    expect(emailOtpErrorKey(new Error("boom"))).toBe("settings.account.email.errors.generic")
    expect(emailOtpErrorKey(undefined)).toBe("settings.account.email.errors.generic")
  })
})
