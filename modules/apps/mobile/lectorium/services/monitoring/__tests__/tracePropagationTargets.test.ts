import { describe, expect, it } from "vitest"
import { SERVERS } from "@lib/domain/servers.js"
import { shouldPropagateTrace } from "../tracePropagationTargets.js"

describe("shouldPropagateTrace", () => {
  it("propagates to every shipped region's chat and auth origin", () => {
    // The point of the pattern: it must cover the real region list, not a
    // hand-copied subset that drifts when a region is added or flipped.
    expect(SERVERS.length).toBeGreaterThan(0)
    for (const server of SERVERS) {
      expect(shouldPropagateTrace(`${server.chatBaseUrl}/chat`)).toBe(true)
      expect(shouldPropagateTrace(`${server.authBaseUrl}/anonymous`)).toBe(true)
    }
  })

  it("propagates to a region that does not exist yet", () => {
    // Regions arrive at runtime via config.json, so a new host must work
    // without an app release.
    expect(shouldPropagateTrace("https://10-0-0-1.sslip.io/chat")).toBe(true)
  })

  it("propagates to the local dev stack", () => {
    expect(shouldPropagateTrace("http://localhost:11080/chat")).toBe(true)
    expect(shouldPropagateTrace("http://localhost:11081/auth/anonymous")).toBe(true)
  })

  it("does not leak the tracing headers to third parties", () => {
    // A `sentry-trace` header sent off-estate leaks our trace ids and can trip
    // the other side's CORS allow-list.
    for (const url of [
      "https://akds-lectorium.b-cdn.net/tracks/1.mp3",
      "https://akds-lectorium.storage.yandexcloud.net/config.json",
      "https://api.revenuecat.com/v1/subscribers",
      "https://play.google.com/store/apps/details",
      "https://sslip.io/",
      "https://evil.example/?u=https://api.example.test/",
    ]) {
      expect(shouldPropagateTrace(url)).toBe(false)
    }
  })
})
