// @vitest-environment jsdom
/**
 * Qase cases 573, 574. The in-app answer to #1890: on iOS the viewport meta
 * ships `user-scalable=no`, WKWebView ignores Dynamic Type, and Ionic's
 * typography pins the root to a literal 16px behind
 * `@supports(-webkit-touch-callout: none)` — so a low-vision reader had no way
 * to enlarge a transcript or a verse at all.
 *
 * What is asserted here is the contract the whole feature rests on: the scale
 * lands on the document root as a **percentage** (relative to the WebView's
 * default, which on Android already carries the system font size — an
 * absolute px would silently take that away), and no stored value can render
 * the app unreadable.
 */
import { beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_TEXT_SCALE,
  TEXT_SCALE_PRESETS,
  applyTextScale,
  clampTextScale,
} from "../useTextScale.js"

describe("text scale", () => {
  beforeEach(() => {
    document.documentElement.style.fontSize = ""
  })

  /* -- Applying ------------------------------------------------------- */

  it("writes the scale onto the document root as a percentage", () => {
    applyTextScale(1.3)

    expect(document.documentElement.style.fontSize).toBe("130%")
  })

  it("leaves the platform default untouched at the default scale", () => {
    // 100% of the WebView's own default — which is how Android's system
    // font-size setting keeps working. A px value here would pin it.
    applyTextScale(DEFAULT_TEXT_SCALE)

    expect(document.documentElement.style.fontSize).toBe("100%")
  })

  it("applies to an explicit root, so a caller can scope it", () => {
    const root = document.createElement("div")

    applyTextScale(1.15, root)

    expect(root.style.fontSize).toBe("115%")
    expect(document.documentElement.style.fontSize).toBe("")
  })

  it("renders every shipped preset as a whole percentage", () => {
    for (const preset of TEXT_SCALE_PRESETS) {
      applyTextScale(preset)
      expect(document.documentElement.style.fontSize).toMatch(/^\d+%$/)
    }
  })

  /* -- Clamping ------------------------------------------------------- */

  it("refuses a scale below the smallest preset", () => {
    // A stored value that predates a preset change must not be able to
    // shrink the app past legibility.
    expect(clampTextScale(0.1)).toBe(TEXT_SCALE_PRESETS[0])
  })

  it("refuses a scale above the largest preset", () => {
    // The player, the tab bar and the onboarding carousel are laid out in
    // fixed px and stop reflowing cleanly well before 2x.
    expect(clampTextScale(4)).toBe(TEXT_SCALE_PRESETS[TEXT_SCALE_PRESETS.length - 1])
  })

  it("falls back to the default for anything that is not a number", () => {
    expect(clampTextScale(undefined)).toBe(DEFAULT_TEXT_SCALE)
    expect(clampTextScale(null)).toBe(DEFAULT_TEXT_SCALE)
    expect(clampTextScale("large")).toBe(DEFAULT_TEXT_SCALE)
    expect(clampTextScale(Number.NaN)).toBe(DEFAULT_TEXT_SCALE)
  })

  it("clamps on the way out, not only on the way in", () => {
    applyTextScale(9)

    expect(document.documentElement.style.fontSize).toBe("150%")
  })

  it("keeps 1 in the preset list, so the default is always selectable", () => {
    expect(TEXT_SCALE_PRESETS).toContain(DEFAULT_TEXT_SCALE)
  })
})
