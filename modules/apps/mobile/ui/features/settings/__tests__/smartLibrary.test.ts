import { describe, expect, it } from "vitest"
import {
  ARCHIVE_OPTIONS,
  DEFAULT_TARGET_SECONDS,
  archiveOptionKey,
  isSmartLibraryEnabled,
  smartLibraryToggled,
  type AutoArchiveDelay,
  type SmartLibraryState,
} from "../smartLibrary.js"

describe("ARCHIVE_OPTIONS", () => {
  it("offers 'off' so the archive schedule can be seen and cleared", () => {
    expect(ARCHIVE_OPTIONS).toContain("off")
    expect(ARCHIVE_OPTIONS[0]).toBe("off")
  })
})

describe("archiveOptionKey", () => {
  it("prefixes the numeric buckets and leaves the word ones alone", () => {
    expect(archiveOptionKey("off")).toBe("off")
    expect(archiveOptionKey("immediate")).toBe("immediate")
    expect(archiveOptionKey("8h")).toBe("_8h")
    expect(archiveOptionKey("3d")).toBe("_3d")
  })
})

describe("smartLibraryToggled", () => {
  const on: SmartLibraryState = { targetSeconds: 3600, archiveDelay: "1d" }

  it("clears the archive delay too when switched off", () => {
    expect(smartLibraryToggled(false, on, 3600, "1d")).toEqual({
      targetSeconds: 0,
      archiveDelay: "off",
    })
  })

  it("leaves nothing enabled behind the off switch", () => {
    const next = smartLibraryToggled(
      false,
      { targetSeconds: 1800, archiveDelay: "immediate" },
      1800,
      "immediate"
    )
    expect(isSmartLibraryEnabled(next)).toBe(false)
    expect(next.archiveDelay).toBe("off")
  })

  it("restores the last queue length when switched back on", () => {
    const off: SmartLibraryState = { targetSeconds: 0, archiveDelay: "off" }
    expect(smartLibraryToggled(true, off, 7200, "off")).toEqual({
      targetSeconds: 7200,
      archiveDelay: "off",
    })
  })

  it("falls back to the default queue length when there is no previous one", () => {
    const off: SmartLibraryState = { targetSeconds: 0, archiveDelay: "off" }
    expect(smartLibraryToggled(true, off, 0, "off").targetSeconds).toBe(DEFAULT_TARGET_SECONDS)
  })

  it("never turns archiving on by itself", () => {
    const off: SmartLibraryState = { targetSeconds: 0, archiveDelay: "off" }
    expect(smartLibraryToggled(true, off, 3600, "off").archiveDelay).toBe("off")
  })
})

/**
 * The dialog as a state machine, so an off/on cycle can be driven the way a
 * user drives it. The previous version of the test below asserted the same
 * thing by handing `smartLibraryToggled` a state that had an archive delay AND
 * a live target — a state the off branch can never produce, since it writes
 * `"off"` — so it passed against the very bug it named (#1663).
 */
function dialog(initial: SmartLibraryState): {
  pickArchive: (value: AutoArchiveDelay) => void
  toggle: (checked: boolean) => void
  state: () => SmartLibraryState
} {
  let state = { ...initial }
  let lastTargetSeconds = state.targetSeconds
  // Mirrors the dialog: only a pick made while the feature is on is remembered.
  let lastArchiveDelay: AutoArchiveDelay = isSmartLibraryEnabled(state) ? state.archiveDelay : "off"
  return {
    pickArchive(value) {
      state = { ...state, archiveDelay: value }
      if (isSmartLibraryEnabled(state)) lastArchiveDelay = value
    },
    toggle(checked) {
      state = smartLibraryToggled(checked, state, lastTargetSeconds, lastArchiveDelay)
      if (state.targetSeconds > 0) lastTargetSeconds = state.targetSeconds
    },
    state: () => state,
  }
}

describe("the archive schedule across an off/on cycle", () => {
  it("comes back after the master switch is cycled", () => {
    const d = dialog({ targetSeconds: 3600, archiveDelay: "off" })
    d.pickArchive("2d")

    d.toggle(false)
    expect(d.state()).toEqual({ targetSeconds: 0, archiveDelay: "off" })

    d.toggle(true)
    expect(d.state()).toEqual({ targetSeconds: 3600, archiveDelay: "2d" })
  })

  it("keeps an explicit 'Never' distinguishable from a forgotten schedule", () => {
    const d = dialog({ targetSeconds: 3600, archiveDelay: "off" })
    d.pickArchive("2d")
    // The user changes their mind and asks for no archiving at all.
    d.pickArchive("off")

    d.toggle(false)
    d.toggle(true)

    expect(d.state().archiveDelay).toBe("off")
  })

  it("does not invent a schedule for someone who never picked one", () => {
    const d = dialog({ targetSeconds: 3600, archiveDelay: "off" })
    d.toggle(false)
    d.toggle(true)
    expect(d.state().archiveDelay).toBe("off")
  })
})
