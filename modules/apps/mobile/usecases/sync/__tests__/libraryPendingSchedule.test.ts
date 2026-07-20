import { describe, expect, it } from "vitest"
import type { LibraryItem } from "@lib/domain/libraryItem.js"
import {
  IDLE_SYNC_INTERVAL_MS,
  PENDING_SYNC_MAX_MS,
  PENDING_SYNC_MIN_MS,
  hasPendingLibraryItems,
  isPendingLibraryItem,
  nextSyncDelayMs,
} from "../libraryPendingSchedule.js"

const item = (status: LibraryItem["status"]): Pick<LibraryItem, "status"> => ({ status })

describe("isPendingLibraryItem", () => {
  it("treats queued/processing as pending, ready/failed as settled", () => {
    expect(isPendingLibraryItem(item("queued"))).toBe(true)
    expect(isPendingLibraryItem(item("processing"))).toBe(true)
    expect(isPendingLibraryItem(item("ready"))).toBe(false)
    expect(isPendingLibraryItem(item("failed"))).toBe(false)
  })
})

describe("hasPendingLibraryItems", () => {
  it("is false for an empty list", () => {
    expect(hasPendingLibraryItems([])).toBe(false)
  })

  it("is true iff at least one item is still being ingested", () => {
    expect(hasPendingLibraryItems([item("ready"), item("failed")])).toBe(false)
    expect(hasPendingLibraryItems([item("ready"), item("processing")])).toBe(true)
  })
})

describe("nextSyncDelayMs", () => {
  it("uses the flat idle interval when nothing is pending", () => {
    expect(nextSyncDelayMs(false, null)).toBe(IDLE_SYNC_INTERVAL_MS)
    // Idle regardless of any carried-over backoff value.
    expect(nextSyncDelayMs(false, PENDING_SYNC_MAX_MS)).toBe(IDLE_SYNC_INTERVAL_MS)
  })

  it("starts the short cadence at the minimum on the first pending cycle", () => {
    // prev === null means we were idle before → start fast.
    expect(nextSyncDelayMs(true, null)).toBe(PENDING_SYNC_MIN_MS)
  })

  it("doubles the backoff each subsequent pending cycle", () => {
    expect(nextSyncDelayMs(true, PENDING_SYNC_MIN_MS)).toBe(PENDING_SYNC_MIN_MS * 2)
    expect(nextSyncDelayMs(true, PENDING_SYNC_MIN_MS * 2)).toBe(PENDING_SYNC_MIN_MS * 4)
  })

  it("caps the backoff at the maximum", () => {
    expect(nextSyncDelayMs(true, PENDING_SYNC_MAX_MS)).toBe(PENDING_SYNC_MAX_MS)
    expect(nextSyncDelayMs(true, PENDING_SYNC_MAX_MS * 2)).toBe(PENDING_SYNC_MAX_MS)
  })

  it("models the full lifecycle: idle → pending backoff → back to idle", () => {
    // A driver mirroring useSyncEngine.scheduleNextPoll: carry the delay back
    // as `prev` only while pending, reset to null once idle.
    let prev: number | null = null
    const step = (hasPending: boolean): number => {
      const delay = nextSyncDelayMs(hasPending, prev)
      prev = hasPending ? delay : null
      return delay
    }

    expect(step(false)).toBe(IDLE_SYNC_INTERVAL_MS) // at rest
    expect(step(true)).toBe(PENDING_SYNC_MIN_MS) // item added → fast
    expect(step(true)).toBe(PENDING_SYNC_MIN_MS * 2) // still processing → back off
    expect(step(true)).toBe(PENDING_SYNC_MIN_MS * 4)
    expect(step(false)).toBe(IDLE_SYNC_INTERVAL_MS) // ready/failed → idle again
    expect(step(true)).toBe(PENDING_SYNC_MIN_MS) // a new pending item restarts fast
  })
})
