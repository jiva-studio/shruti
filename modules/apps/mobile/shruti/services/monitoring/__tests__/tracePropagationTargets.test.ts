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

  it("does not propagate to storage reads served through a region's own host", () => {
    // An edge serves /public/* from the CDN on the same host as the services;
    // a tracing header there would force a CORS preflight the CDN answers.
    for (const server of SERVERS) {
      const origin = new URL(server.chatBaseUrl).origin
      expect(shouldPropagateTrace(`${origin}/public/config.json`)).toBe(false)
      expect(shouldPropagateTrace(`${origin}/public/tracks/t/audio/original.mp3`)).toBe(false)
    }
    expect(shouldPropagateTrace("https://10-0-0-1.sslip.io/public/db/shruti.7.db")).toBe(false)
    expect(shouldPropagateTrace("https://10-0-0-1.sslip.io/publications")).toBe(true)
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
      "https://cdn.shruti.local/tracks/1.mp3",
      "https://cdn-ru.shruti.local/config.json",
      "https://api.revenuecat.com/v1/subscribers",
      "https://play.google.com/store/apps/details",
      "https://sslip.io/",
      "https://evil.example/?u=https://api.example.test/",
    ]) {
      expect(shouldPropagateTrace(url)).toBe(false)
    }
  })
})
