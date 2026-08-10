import { describe, expect, it } from "vitest"
import {
  ARCHIVE_OPTIONS,
  DEFAULT_TARGET_SECONDS,
  archiveOptionKey,
  isSmartLibraryEnabled,
  smartLibraryToggled,
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
    expect(smartLibraryToggled(false, on, 3600)).toEqual({
      targetSeconds: 0,
      archiveDelay: "off",
    })
  })

  it("leaves nothing enabled behind the off switch", () => {
    const next = smartLibraryToggled(
      false,
      { targetSeconds: 1800, archiveDelay: "immediate" },
      1800
    )
    expect(isSmartLibraryEnabled(next)).toBe(false)
    expect(next.archiveDelay).toBe("off")
  })

  it("restores the last queue length when switched back on", () => {
    const off: SmartLibraryState = { targetSeconds: 0, archiveDelay: "off" }
    expect(smartLibraryToggled(true, off, 7200)).toEqual({
      targetSeconds: 7200,
      archiveDelay: "off",
    })
  })

  it("falls back to the default queue length when there is no previous one", () => {
    const off: SmartLibraryState = { targetSeconds: 0, archiveDelay: "off" }
    expect(smartLibraryToggled(true, off, 0).targetSeconds).toBe(DEFAULT_TARGET_SECONDS)
  })

  it("never turns archiving on by itself", () => {
    const off: SmartLibraryState = { targetSeconds: 0, archiveDelay: "off" }
    expect(smartLibraryToggled(true, off, 3600).archiveDelay).toBe("off")
  })

  it("keeps an explicitly chosen delay across an off/on cycle of the dialog", () => {
    const chosen: SmartLibraryState = { targetSeconds: 3600, archiveDelay: "2d" }
    expect(smartLibraryToggled(true, chosen, 3600).archiveDelay).toBe("2d")
  })
})
