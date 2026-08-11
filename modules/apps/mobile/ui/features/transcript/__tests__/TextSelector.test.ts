// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, h } from "vue"

/**
 * Drag-selection over the transcript (issue #1732).
 *
 * `selecting` paints the live highlight, `selected` is what gets saved as a
 * note / sent to "Ask Sadhu" / shared. They have to describe the SAME span:
 * the user only ever agrees to what the highlight showed. The regression was
 * that each `selecting` branch mixed one running endpoint with the fixed
 * anchor, while the release emitted the running PAIR — so a drag that crossed
 * the anchor saved a range that had never been highlighted.
 *
 * jsdom has no layout, so `resolveSentenceAt`'s hit-testing is fed by a stubbed
 * `document.elementsFromPoint`: the touch's `clientY` is the index of the
 * sentence span under the finger.
 */

let longPress: (() => void) | undefined
vi.mock("@vueuse/core", () => ({
  onLongPress: (_target: unknown, handler: () => void) => {
    longPress = handler
  },
}))

const TextSelector = (await import("../TextSelector.vue")).default

/** Four sentences, non-adjacent in time so the anchor sits strictly between. */
const SENTENCES: readonly [number, number][] = [
  [5000, 8000],
  [10000, 12000],
  [14000, 16000],
  [20000, 22000],
]
const ANCHOR = 1
const FAR = 3

interface Harness {
  root: HTMLElement
  selecting: [number, number][]
  selected: [number, number][]
  unmount: () => void
}

function mountSelector(): Harness {
  const selecting: [number, number][] = []
  const selected: [number, number][] = []
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
        },
        {
          default: () =>
            SENTENCES.map(([start, end], i) =>
              h("span", {
                class: "sentence",
                "data-index": String(i),
                "data-time-start": String(start),
                "data-time-end": String(end),
              })
            ),
        }
      ),
  })
  app.mount(host)

  const spans = Array.from(host.querySelectorAll<HTMLElement>(".sentence"))
  document.elementsFromPoint = (_x: number, y: number) => {
    const el = spans[y]
    return el ? [el] : []
  }

  const root = host.firstElementChild as HTMLElement
  return { root, selecting, selected, unmount: () => app.unmount() }
}

/** Dispatch a touch event whose single touch point sits over sentence `index`. */
function touch(root: HTMLElement, type: "touchstart" | "touchmove" | "touchend", index?: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "touches", {
    value: index === undefined ? [] : [{ clientX: 0, clientY: index }],
  })
  root.dispatchEvent(event)
}

afterEach(() => {
  longPress = undefined
  document.body.innerHTML = ""
})

describe("TextSelector — drag selection", () => {
  it("saves exactly the range it last highlighted when the drag crosses the anchor downwards first", () => {
    const { root, selecting, selected, unmount } = mountSelector()

    touch(root, "touchstart", ANCHOR)
    longPress?.()
    touch(root, "touchmove", FAR) // past the anchor's end
    touch(root, "touchmove", 0) // back across the anchor, past its start
    touch(root, "touchend")

    expect(selected).toHaveLength(1)
    expect(selected[0]).toEqual(selecting[selecting.length - 1])
    unmount()
  })

  it("saves exactly the range it last highlighted when the drag crosses the anchor upwards first", () => {
    const { root, selecting, selected, unmount } = mountSelector()

    touch(root, "touchstart", ANCHOR)
    longPress?.()
    touch(root, "touchmove", 0) // past the anchor's start
    touch(root, "touchmove", FAR) // back across the anchor, past its end
    touch(root, "touchend")

    expect(selected).toHaveLength(1)
    expect(selected[0]).toEqual(selecting[selecting.length - 1])
    unmount()
  })

  /**
   * Retraction, kept deliberately as it was: the edge under the finger follows
   * it back toward the anchor, so an overshoot is recoverable mid-drag.
   */
  it("retracts the dragged edge when the finger moves back toward the anchor", () => {
    const { root, selecting, selected, unmount } = mountSelector()

    touch(root, "touchstart", ANCHOR)
    longPress?.()
    touch(root, "touchmove", FAR)
    touch(root, "touchmove", 2) // still past the anchor, but nearer

    expect(selecting[selecting.length - 1]).toEqual([SENTENCES[ANCHOR][0], SENTENCES[2][1]])

    touch(root, "touchend")
    expect(selected[0]).toEqual([SENTENCES[ANCHOR][0], SENTENCES[2][1]])
    unmount()
  })

  /**
   * The other half of that decision: crossing the anchor extends the opposite
   * edge instead of collapsing the one already extended. A touch drag has no
   * grab handles, so a selection made on the far side is not thrown away by a
   * move across the start sentence — and now the highlight says so.
   */
  it("keeps the far edge when the drag crosses the anchor", () => {
    const { root, selecting, selected, unmount } = mountSelector()

    touch(root, "touchstart", ANCHOR)
    longPress?.()
    touch(root, "touchmove", FAR)
    touch(root, "touchmove", 0)
    touch(root, "touchmove", ANCHOR) // back onto the anchor — neither edge moves
    touch(root, "touchend")

    expect(selected[0]).toEqual([SENTENCES[0][0], SENTENCES[FAR][1]])
    expect(selecting[selecting.length - 1]).toEqual([SENTENCES[0][0], SENTENCES[FAR][1]])
    unmount()
  })

  it("emits the anchor sentence alone when the long-press never moves", () => {
    const { root, selecting, selected, unmount } = mountSelector()

    touch(root, "touchstart", ANCHOR)
    longPress?.()
    touch(root, "touchend")

    expect(selecting).toEqual([[SENTENCES[ANCHOR][0], SENTENCES[ANCHOR][1]]])
    expect(selected[0]).toEqual([SENTENCES[ANCHOR][0], SENTENCES[ANCHOR][1]])
    unmount()
  })
})
