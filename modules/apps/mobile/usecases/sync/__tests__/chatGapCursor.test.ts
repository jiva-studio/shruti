import { describe, expect, it } from "vitest"
import { nextChatGapCursor, rewindCursorForChatGap } from "../chatGapCursor.js"

describe("nextChatGapCursor", () => {
  it("opens a gap at the cursor the first chat change was passed over", () => {
    expect(
      nextChatGapCursor({ chatEnabled: false, gapBefore: null, skippedAt: 40, caughtUp: true })
    ).toBe(40)
  })

  it("leaves the watermark alone when nothing was skipped", () => {
    expect(
      nextChatGapCursor({ chatEnabled: false, gapBefore: null, skippedAt: null, caughtUp: true })
    ).toBeUndefined()
  })

  it("keeps the lower floor, so a second off cycle cannot strand the first", () => {
    expect(
      nextChatGapCursor({ chatEnabled: false, gapBefore: 10, skippedAt: 90, caughtUp: true })
    ).toBeUndefined()
  })

  it("lowers the floor when this cycle skipped earlier than the stored gap", () => {
    expect(
      nextChatGapCursor({ chatEnabled: false, gapBefore: 90, skippedAt: 10, caughtUp: true })
    ).toBe(10)
  })

  it("clears the gap once the re-pull ran to the end", () => {
    expect(
      nextChatGapCursor({ chatEnabled: true, gapBefore: 10, skippedAt: null, caughtUp: true })
    ).toBeNull()
  })

  it("keeps the gap when the re-pull was cut short", () => {
    expect(
      nextChatGapCursor({ chatEnabled: true, gapBefore: 10, skippedAt: null, caughtUp: false })
    ).toBeUndefined()
  })

  it("has nothing to clear when no gap was outstanding", () => {
    expect(
      nextChatGapCursor({ chatEnabled: true, gapBefore: null, skippedAt: null, caughtUp: true })
    ).toBeUndefined()
  })
})

describe("rewindCursorForChatGap", () => {
  it("rewinds to the gap floor when the toggle comes back on", () => {
    expect(rewindCursorForChatGap(true, 10, 90)).toBe(10)
  })

  it("stays put when the cursor has not passed the floor yet", () => {
    expect(rewindCursorForChatGap(true, 90, 90)).toBeNull()
    expect(rewindCursorForChatGap(true, 90, 10)).toBeNull()
  })

  it("stays put with the toggle off, or with no gap outstanding", () => {
    expect(rewindCursorForChatGap(false, 10, 90)).toBeNull()
    expect(rewindCursorForChatGap(true, null, 90)).toBeNull()
  })
})
