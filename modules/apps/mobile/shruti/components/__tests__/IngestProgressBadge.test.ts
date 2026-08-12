// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h } from "vue"

import IngestProgressBadge from "../IngestProgressBadge.vue"

/**
 * The stage label must stay inside the pill (#1789).
 *
 * The badge sits on the tile's cover art, capped at `calc(100% - 12px)` by
 * `TileCorner`. On a two-column grid at 360 CSS px that is a 145 px pill with
 * about 43 px of chrome (ring, gap, padding), leaving ~102 px for text. German
 * ran past it — "Wird heruntergeladen" is about 150 px — and because the label
 * is a `white-space: nowrap` flex item with an automatic minimum size, it
 * refused to shrink: the text painted outside the dark pill onto the cover and
 * was chopped mid-glyph by the tile's own clip.
 *
 * jsdom does no layout, so the overflow itself cannot be measured here; what is
 * asserted is the cascade that decides it — the label may shrink, and clips
 * with an ellipsis when it does. That is exactly the pair a regression drops:
 * f6cb6a0b removed the clipping alone and left the label free to overflow.
 */

function mountBadge(label: string): { badge: HTMLElement; label: HTMLElement } {
  const host = document.createElement("div")
  document.body.appendChild(host)
  createApp({ render: () => h(IngestProgressBadge, { label }) }).mount(host)
  return {
    badge: host.querySelector(".ingest-badge") as HTMLElement,
    label: host.querySelector(".label") as HTMLElement,
  }
}

describe("IngestProgressBadge", () => {
  it("lets a stage name wider than the pill truncate instead of overflowing it", () => {
    const { badge, label } = mountBadge("Wird heruntergeladen")

    // The pill never grows past its container — the text has to give way.
    expect(getComputedStyle(badge).maxWidth).toBe("100%")
    expect(getComputedStyle(badge).whiteSpace).toBe("nowrap")

    const style = getComputedStyle(label)
    // Without this the nowrap label floors at its min-content width and spills.
    expect(style.minWidth).toBe("0px")
    expect(style.overflow).toBe("hidden")
    expect(style.textOverflow).toBe("ellipsis")
  })

  it("clips outside the glyph ink, at no cost to the pill's size", () => {
    // Why the clipping was removed in the first place: `overflow: hidden` cut
    // the descender of the last "g" in "Downloading". The clip box is padded
    // past the ink, and the negative margin gives the width back.
    const style = getComputedStyle(mountBadge("Downloading").label)

    const padding = Number.parseFloat(style.paddingRight)
    expect(padding).toBeGreaterThan(0)
    expect(Number.parseFloat(style.paddingBottom)).toBeGreaterThan(0)
    expect(Number.parseFloat(style.marginRight)).toBe(-padding)
    expect(Number.parseFloat(style.marginBottom)).toBe(-padding)
  })
})
