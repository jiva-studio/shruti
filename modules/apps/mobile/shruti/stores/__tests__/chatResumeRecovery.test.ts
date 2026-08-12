import { describe, expect, it } from "vitest"
import {
  decideResumeRecovery,
  RESUME_RECOVERY_GRACE_MS,
  type ResumeProbe,
} from "../chatResumeRecovery.js"

/**
 * When a dropped turn stops being "recovering" and becomes "give the user a
 * Retry" — the whole decision behind the button, stated without a browser.
 */

const DAY_MS = 24 * 60 * 60 * 1000

function decide(probe: ResumeProbe, over: { unproductiveForMs?: number; ageMs?: number } = {}) {
  return decideResumeRecovery({
    probe,
    unproductiveForMs: over.unproductiveForMs ?? 0,
    ageMs: over.ageMs ?? 1000,
    ttlMs: DAY_MS,
  })
}

describe("decideResumeRecovery", () => {
  it("keeps polling a turn the server says it is still generating", () => {
    // The trigger that would be wrong: "the stream went quiet". A stall hands
    // the turn to the resume poll, and a research answer legitimately takes
    // minutes — a button here races the recovery that is already under way.
    expect(decide("running", { unproductiveForMs: 10 * 60_000 })).toBe("poll")
    expect(decide("running", { ageMs: DAY_MS - 1 })).toBe("poll")
  })

  it("tolerates a 404 that is our poll racing the server's buffer write", () => {
    expect(decide("missing")).toBe("poll")
    expect(decide("missing", { unproductiveForMs: RESUME_RECOVERY_GRACE_MS - 1 })).toBe("poll")
  })

  it("gives up once the server has kept saying it has nothing", () => {
    expect(decide("missing", { unproductiveForMs: RESUME_RECOVERY_GRACE_MS })).toBe("abandon")
  })

  it("gives up when the poll could not reach the server for the whole window", () => {
    expect(decide("unreachable")).toBe("poll")
    expect(decide("unreachable", { unproductiveForMs: RESUME_RECOVERY_GRACE_MS })).toBe("abandon")
  })

  it("gives up on anything older than the server buffer TTL, running included", () => {
    expect(decide("running", { ageMs: DAY_MS + 1 })).toBe("abandon")
    expect(decide("missing", { ageMs: DAY_MS + 1 })).toBe("abandon")
  })

  it("takes the caller's window when one is passed", () => {
    expect(
      decideResumeRecovery({
        probe: "missing",
        unproductiveForMs: 500,
        ageMs: 1000,
        ttlMs: DAY_MS,
        graceMs: 400,
      })
    ).toBe("abandon")
  })
})
