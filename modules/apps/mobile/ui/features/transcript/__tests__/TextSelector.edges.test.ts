// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, h } from "vue"

/**
 * The degraded ends of the long-press selection: a press that lands on
 * something unselectable (a verse block, the gap between sentences), a drag
 * that never became a selection, and a release whose touch point sits on
 * whitespace rather than on a sentence.
 *
 * jsdom has no layout, so hit-testing is fed by a stubbed
 * `document.elementsFromPoint` and per-element rectangles.
 */

let longPress: (() => void) | undefined
vi.mock("@vueuse/core", () => ({
  onLongPress: (_target: unknown, handler: () => void) => {
    longPress = handler
  },
}))

const TextSelector = (await import("../TextSelector.vue")).default

const SENTENCES: readonly [number, number][] = [
  [5000, 8000],
  [10000, 12000],
  [14000, 16000],
]
/** Horizontal centre of sentence `i`, matching the stubbed rectangles. */
const CENTRE = (i: number): number => i * 100 + 50

interface Harness {
  readonly root: HTMLElement
  readonly selecting: [number, number][]
  readonly selected: [number, number][]
  readonly pickStarts: number
  readonly unmount: () => void
}

/**
 * Three sentence spans plus two decoys the press can land on: a verse block
 * that carries no timings at all, and a whitespace wrapper nested inside each
 * sentence (what a release between two sentences actually hits).
 */
function mountSelector(stackAt: (y: number, root: HTMLElement) => HTMLElement[]): Harness {
  const selecting: [number, number][] = []
  const selected: [number, number][] = []
  const counters = { pickStarts: 0 }
  const host = document.createElement("div")
  document.body.appendChild(host)

  const app = createApp({
    render: () =>
      h(
        TextSelector,
        {
          datasetFieldStart: "data-time-start",
          datasetFieldEnd: "data-time-end",
          onSelecting: (start: number, end: number) => selecting.push([start, end]),
          onSelected: (start: number, end: number) => selected.push([start, end]),
          "onPick-start": () => (counters.pickStarts += 1),
        },
        {
          default: () => [
            ...SENTENCES.map(([start, end], i) =>
              h(
                "span",
                {
                  class: "sentence",
                  "data-index": String(i),
                  "data-time-start": String(start),
                  "data-time-end": String(end),
                },
                [h("span", { class: "gap" })]
              )
            ),
            h("span", { class: "verse" }, "dehino 'smin"),
            h("span", { class: "half", "data-time-start": "30000" }),
          ],
        }
      ),
  })
  app.mount(host)

  const spans = Array.from(host.querySelectorAll<HTMLElement>(".sentence"))
  spans.forEach((span, i) => {
    span.getBoundingClientRect = () => new DOMRect(i * 100, 0, 100, 20)
  })

  const root = host.firstElementChild as HTMLElement
  document.elementsFromPoint = (_x: number, y: number) => stackAt(y, root)
  return {
    root,
    selecting,
    selected,
    get pickStarts() {
      return counters.pickStarts
    },
    unmount: () => app.unmount(),
  }
}

/** The element a press at `y` lands on, addressed the way the cases read. */
function at(root: HTMLElement, selector: string): HTMLElement {
  return root.querySelector<HTMLElement>(selector) as HTMLElement
}

function touch(
  root: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend",
  point?: { x?: number; y: number }
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "touches", {
    value: point === undefined ? [] : [{ clientX: point.x ?? 0, clientY: point.y }],
  })
  root.dispatchEvent(event)
}

afterEach(() => {
  longPress = undefined
  document.body.innerHTML = ""
})

/** A stack that resolves y=0..2 to the matching sentence span. */
function directHits(root: HTMLElement) {
  return (y: number): HTMLElement[] => {
    const el = root.querySelectorAll<HTMLElement>(".sentence")[y]
    return el ? [el] : []
  }
}

describe("a long-press that lands on nothing selectable", () => {
  it("highlights nothing and saves nothing", () => {
    const harness = mountSelector((y, root) => (y === 9 ? [at(root, ".verse")] : []))

    touch(harness.root, "touchstart", { y: 9 })
    longPress?.()
    touch(harness.root, "touchend")

    expect(harness.selecting).toEqual([])
    expect(harness.selected).toEqual([])
    harness.unmount()
  })

  it("does not ask the parent for the haptic tick", () => {
    const harness = mountSelector((y, root) => (y === 9 ? [at(root, ".verse")] : []))

    touch(harness.root, "touchstart", { y: 9 })
    longPress?.()

    expect(harness.pickStarts).toBe(0)
    harness.unmount()
  })

  it("treats a block carrying only one of the two timings as unselectable", () => {
    const harness = mountSelector((y, root) => (y === 9 ? [at(root, ".half")] : []))

    touch(harness.root, "touchstart", { y: 9 })
    longPress?.()
    touch(harness.root, "touchend")

    expect(harness.selecting).toEqual([])
    expect(harness.selected).toEqual([])
    harness.unmount()
  })

  it("does not resurrect the previous gesture's span", () => {
    const harness = mountSelector((y, root) =>
      y === 9 ? [at(root, ".verse")] : directHits(root)(y)
    )

    touch(harness.root, "touchstart", { y: 1 })
    longPress?.()
    touch(harness.root, "touchend")
    expect(harness.selected).toHaveLength(1)

    touch(harness.root, "touchstart", { y: 9 })
    longPress?.()
    touch(harness.root, "touchend")

    expect(harness.selected).toHaveLength(1)
    harness.unmount()
  })
})

describe("a touch that never became a selection", () => {
  it("saves nothing when the press was too short to be a long-press", () => {
    const harness = mountSelector((y, root) => directHits(root)(y))

    touch(harness.root, "touchstart", { y: 1 })
    touch(harness.root, "touchend")

    expect(harness.selecting).toEqual([])
    expect(harness.selected).toEqual([])
    harness.unmount()
  })

  it("does not highlight while the finger drags before the long-press fires", () => {
    const harness = mountSelector((y, root) => directHits(root)(y))

    touch(harness.root, "touchstart", { y: 1 })
    touch(harness.root, "touchmove", { y: 2 })
    touch(harness.root, "touchmove", { y: 0 })

    expect(harness.selecting).toEqual([])
    harness.unmount()
  })

  it("keeps the current span when a move arrives with no touch points left", () => {
    const harness = mountSelector((y, root) => directHits(root)(y))

    touch(harness.root, "touchstart", { y: 1 })
    longPress?.()
    touch(harness.root, "touchmove")
    touch(harness.root, "touchend")

    expect(harness.selected).toEqual([[SENTENCES[1][0], SENTENCES[1][1]]])
    harness.unmount()
  })

  it("leaves selection mode behind, so the next plain tap saves nothing", () => {
    const harness = mountSelector((y, root) => directHits(root)(y))

    touch(harness.root, "touchstart", { y: 1 })
    longPress?.()
    touch(harness.root, "touchend")

    touch(harness.root, "touchstart", { y: 2 })
    touch(harness.root, "touchend")

    expect(harness.selected).toHaveLength(1)
    harness.unmount()
  })
})

describe("a touch that lands between two sentences", () => {
  /**
   * `elementsFromPoint` returns the whitespace wrappers, never a sentence
   * itself; the selection has to snap to the sentence whose centre is nearest
   * horizontally rather than bind to whatever ancestor they share.
   */
  function gapStack(root: HTMLElement, order: number[]): HTMLElement[] {
    const spans = Array.from(root.querySelectorAll<HTMLElement>(".sentence"))
    return order.map((i) => spans[i].querySelector<HTMLElement>(".gap") as HTMLElement)
  }

  it("snaps to the sentence nearest the finger, not to the first one probed", () => {
    const harness = mountSelector((_y, root) => gapStack(root, [0, 2]))

    touch(harness.root, "touchstart", { x: CENTRE(2), y: 0 })
    longPress?.()
    touch(harness.root, "touchend")

    expect(harness.selected).toEqual([[SENTENCES[2][0], SENTENCES[2][1]]])
    harness.unmount()
  })

  it("snaps the other way when the finger is nearer the earlier sentence", () => {
    const harness = mountSelector((_y, root) => gapStack(root, [2, 0]))

    touch(harness.root, "touchstart", { x: CENTRE(0), y: 0 })
    longPress?.()
    touch(harness.root, "touchend")

    expect(harness.selected).toEqual([[SENTENCES[0][0], SENTENCES[0][1]]])
    harness.unmount()
  })

  it("prefers a sentence hit outright over a nearer whitespace wrapper", () => {
    const harness = mountSelector((_y, root) => {
      const spans = Array.from(root.querySelectorAll<HTMLElement>(".sentence"))
      return [spans[1], spans[2].querySelector<HTMLElement>(".gap") as HTMLElement]
    })

    touch(harness.root, "touchstart", { x: CENTRE(2), y: 0 })
    longPress?.()
    touch(harness.root, "touchend")

    expect(harness.selected).toEqual([[SENTENCES[1][0], SENTENCES[1][1]]])
    harness.unmount()
  })

  it("extends the selection to the sentence a drag onto whitespace snapped to", () => {
    let gap = false
    const harness = mountSelector((y, root) => {
      if (!gap) return directHits(root)(y)
      const spans = Array.from(root.querySelectorAll<HTMLElement>(".sentence"))
      return [spans[2].querySelector<HTMLElement>(".gap") as HTMLElement]
    })

    touch(harness.root, "touchstart", { y: 0 })
    longPress?.()
    gap = true
    touch(harness.root, "touchmove", { x: CENTRE(2), y: 0 })
    touch(harness.root, "touchend")

    expect(harness.selected).toEqual([[SENTENCES[0][0], SENTENCES[2][1]]])
    harness.unmount()
  })
})

describe("a long-press that lands on a sentence", () => {
  it("asks the parent for the haptic tick once", () => {
    const harness = mountSelector((y, root) => directHits(root)(y))

    touch(harness.root, "touchstart", { y: 1 })
    longPress?.()

    expect(harness.pickStarts).toBe(1)
    expect(harness.selecting).toEqual([[SENTENCES[1][0], SENTENCES[1][1]]])
    harness.unmount()
  })
})
