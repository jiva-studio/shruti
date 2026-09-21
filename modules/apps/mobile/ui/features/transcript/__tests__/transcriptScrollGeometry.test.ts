// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  isAdjacentBlock,
  isDriftingOffBottom,
  isInViewport,
  isSeekTransient,
  scrollTargetTop,
} from "../transcriptScrollGeometry.js"

const host = { top: 0, bottom: 1000, height: 1000 }

describe("isInViewport", () => {
  it("counts a block that overlaps the host at all", () => {
    expect(isInViewport(host, { top: 400, bottom: 500, height: 100 })).toBe(true)
    expect(isInViewport(host, { top: -50, bottom: 10, height: 60 })).toBe(true)
  })

  it("rejects a block entirely above or below", () => {
    expect(isInViewport(host, { top: -200, bottom: -100, height: 100 })).toBe(false)
    expect(isInViewport(host, { top: 1100, bottom: 1200, height: 100 })).toBe(false)
  })
})

describe("isDriftingOffBottom", () => {
  it("fires once the block's bottom passes the comfort band", () => {
    expect(isDriftingOffBottom(host, { top: 850, bottom: 950, height: 100 })).toBe(true)
    expect(isDriftingOffBottom(host, { top: 700, bottom: 800, height: 100 })).toBe(false)
  })
})

describe("scrollTargetTop", () => {
  it("leaves a tenth of the viewport above the block", () => {
    expect(scrollTargetTop(host, { top: 500, bottom: 600, height: 100 }, 200)).toBe(600)
  })

  it("never asks for a negative offset", () => {
    expect(scrollTargetTop(host, { top: 20, bottom: 60, height: 40 }, 0)).toBe(0)
  })
})

describe("isSeekTransient", () => {
  it("catches a drop to near-zero from well past it", () => {
    expect(isSeekTransient(60_000, 0)).toBe(true)
  })

  it("leaves a real playhead move alone", () => {
    expect(isSeekTransient(60_000, 30_000)).toBe(false)
    expect(isSeekTransient(700, 0)).toBe(false)
  })
})

describe("isAdjacentBlock", () => {
  function blocks(html: string): HTMLElement {
    const root = document.createElement("div")
    root.innerHTML = html
    return root
  }

  it("steps over a chapter heading between two paragraphs", () => {
    const root = blocks(`<p class="prompter"></p><h2></h2><p class="prompter"></p>`)
    const [first, second] = Array.from(root.querySelectorAll<HTMLElement>("p.prompter"))

    expect(isAdjacentBlock(first!, second!, "p.prompter")).toBe(true)
  })

  it("does not join two paragraphs with a block between them", () => {
    const root = blocks(`<p class="prompter"></p><p class="prompter"></p><p class="prompter"></p>`)
    const all = Array.from(root.querySelectorAll<HTMLElement>("p.prompter"))

    expect(isAdjacentBlock(all[0]!, all[2]!, "p.prompter")).toBe(false)
  })

  it("has nothing to compare on the first block", () => {
    const root = blocks(`<p class="prompter"></p>`)

    expect(isAdjacentBlock(null, root.querySelector("p")!, "p.prompter")).toBe(false)
  })
})
