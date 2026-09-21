import { describe, expect, it } from "vitest"
import { redactEmail, scrubEvent } from "../scrubEvent.js"

describe("redactEmail", () => {
  it("replaces an address and leaves the rest of the string", () => {
    expect(redactEmail("sign-in failed for ann.doe+x@example.co.uk")).toBe(
      "sign-in failed for [email]"
    )
  })

  it("replaces every address in the string", () => {
    expect(redactEmail("a@b.com -> c@d.org")).toBe("[email] -> [email]")
  })

  it("leaves an opaque id alone", () => {
    expect(redactEmail("user 0f3a-91cc")).toBe("user 0f3a-91cc")
  })
})

describe("scrubEvent", () => {
  it("recovers a readable title from the console arguments", () => {
    const event = scrubEvent({
      message: "[object Object]",
      extra: { arguments: [{ code: "E_NET", message: "offline" }] },
    })
    expect(event.message).toBe("E_NET: offline")
  })

  it("keeps a real title", () => {
    const event = scrubEvent({
      message: "[auth] boom",
      extra: { arguments: [{ message: "offline" }] },
    })
    expect(event.message).toBe("[auth] boom")
  })

  it("redacts email from the title and from every exception value", () => {
    const event = scrubEvent({
      message: "otp for a@b.com",
      exception: { values: [{ value: "no account c@d.com" }, {}] },
    })
    expect(event.message).toBe("otp for [email]")
    expect(event.exception.values[0]?.value).toBe("no account [email]")
  })

  it("returns the same object", () => {
    const event = { message: "plain" }
    expect(scrubEvent(event)).toBe(event)
  })
})
