// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type App } from "vue"
import {
  useHorizontalCarousel,
  type UseHorizontalCarouselReturn,
} from "../useHorizontalCarousel.js"

const VIEWPORT_WIDTH = 300

let app: App | null = null
let observed: HTMLElement[] = []
let notifyResize: (() => void) | null = null

vi.stubGlobal(
  "ResizeObserver",
  class {
    constructor(callback: () => void) {
      notifyResize = callback
    }
    observe(el: HTMLElement): void {
      observed.push(el)
    }
    disconnect(): void {
      observed = []
      notifyResize = null
    }
  }
)

afterEach(() => {
  app?.unmount()
  app = null
  observed = []
  notifyResize = null
})

interface Harness {
  readonly api: UseHorizontalCarouselReturn
  readonly viewport: HTMLElement
  readonly setWidth: (width: number) => void
  readonly unmount: () => void
}

function mountCarousel(options: {
  pageCount: number
  initialPage?: number
  width?: number
  swipeDisabled?: () => boolean
  noViewport?: boolean
}): Harness {
  let width = options.width ?? VIEWPORT_WIDTH
  const viewport = document.createElement("div")
  viewport.getBoundingClientRect = () => ({ width }) as DOMRect

  let api: UseHorizontalCarouselReturn | null = null
  const Host = defineComponent({
    setup() {
      api = useHorizontalCarousel({
        pageCount: options.pageCount,
        initialPage: options.initialPage,
        viewportEl: () => (options.noViewport ? null : viewport),
        swipeDisabled: options.swipeDisabled,
      })
      return () => h("div")
    },
  })
  const root = document.createElement("div")
  document.body.appendChild(root)
  app = createApp(Host)
  app.mount(root)
  return {
    api: api as unknown as UseHorizontalCarouselReturn,
    viewport,
    setWidth: (next: number) => void (width = next),
    unmount: () => {
      app?.unmount()
      app = null
      root.remove()
    },
  }
}

/** jsdom has no PointerEvent constructor; a MouseEvent plus the id is enough. */
function pointerEvent(type: string, x: number, y: number, pointerId = 1): PointerEvent {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })
  Object.defineProperty(e, "pointerId", { value: pointerId })
  return e as unknown as PointerEvent
}

function swipe(
  api: UseHorizontalCarouselReturn,
  from: { x: number; y: number },
  to: { x: number; y: number }
): void {
  api.onPointerDown(pointerEvent("pointerdown", from.x, from.y))
  window.dispatchEvent(pointerEvent("pointermove", to.x, to.y))
  window.dispatchEvent(pointerEvent("pointerup", to.x, to.y))
}

describe("measuring the viewport", () => {
  it("measures on mount and watches for resizes", () => {
    const { api, viewport } = mountCarousel({ pageCount: 3 })
    expect(api.viewportWidth.value).toBe(VIEWPORT_WIDTH)
    expect(observed).toEqual([viewport])
  })

  it("re-measures when the viewport is resized", () => {
    const { api, setWidth } = mountCarousel({ pageCount: 3 })
    setWidth(500)
    notifyResize?.()
    expect(api.viewportWidth.value).toBe(500)
  })

  it("stays at zero and observes nothing without a viewport element", () => {
    const { api } = mountCarousel({ pageCount: 3, noViewport: true })
    expect(api.viewportWidth.value).toBe(0)
    expect(observed).toEqual([])
  })

  it("stops observing once the scope is disposed", () => {
    const { unmount } = mountCarousel({ pageCount: 3 })
    unmount()
    expect(observed).toEqual([])
  })
})

describe("the starting page", () => {
  it("opens on page 0 by default", () => {
    expect(mountCarousel({ pageCount: 3 }).api.page.value).toBe(0)
  })

  it("clamps an out-of-range starting page", () => {
    expect(mountCarousel({ pageCount: 3, initialPage: 7 }).api.page.value).toBe(2)
    expect(mountCarousel({ pageCount: 3, initialPage: -1 }).api.page.value).toBe(0)
  })
})

describe("jumping to a page", () => {
  it("goes straight to the asked-for page", () => {
    const { api } = mountCarousel({ pageCount: 4 })
    api.goTo(2)
    expect(api.page.value).toBe(2)
  })

  it("clamps a jump past either end", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    api.goTo(9)
    expect(api.page.value).toBe(2)
    api.goTo(-3)
    expect(api.page.value).toBe(0)
  })
})

describe("horizontal swipes", () => {
  it("advances when the drag passes the commit threshold", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    swipe(api, { x: 250, y: 100 }, { x: 100, y: 100 })
    expect(api.page.value).toBe(1)
    expect(api.dragOffset.value).toBe(0)
    expect(api.pointerId.value).toBeNull()
  })

  it("goes back on a drag the other way", () => {
    const { api } = mountCarousel({ pageCount: 3, initialPage: 2 })
    swipe(api, { x: 50, y: 100 }, { x: 200, y: 100 })
    expect(api.page.value).toBe(1)
  })

  it("snaps back when the drag stops short", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    // 40px of 300 is under the 0.2 commit fraction.
    swipe(api, { x: 250, y: 100 }, { x: 210, y: 100 })
    expect(api.page.value).toBe(0)
  })

  it("tracks the offset while the finger is down", () => {
    const { api } = mountCarousel({ pageCount: 3, initialPage: 1 })
    api.onPointerDown(pointerEvent("pointerdown", 250, 100))
    window.dispatchEvent(pointerEvent("pointermove", 200, 100))
    expect(api.dragOffset.value).toBe(-50)
    expect(api.pointerId.value).toBe(1)
  })

  it("resists a drag past the last page", () => {
    const { api } = mountCarousel({ pageCount: 2, initialPage: 1 })
    api.onPointerDown(pointerEvent("pointerdown", 250, 100))
    window.dispatchEvent(pointerEvent("pointermove", 150, 100))
    expect(api.dragOffset.value).toBeGreaterThan(-100)
    expect(api.dragOffset.value).toBeLessThan(0)
  })

  it("stays on the last page however far the drag goes", () => {
    const { api } = mountCarousel({ pageCount: 2, initialPage: 1 })
    swipe(api, { x: 290, y: 100 }, { x: 5, y: 100 })
    expect(api.page.value).toBe(1)
  })

  it("re-measures at the end of the gesture so a resize mid-swipe still commits", () => {
    const { api, setWidth } = mountCarousel({ pageCount: 3, width: 1000 })
    api.onPointerDown(pointerEvent("pointerdown", 250, 100))
    window.dispatchEvent(pointerEvent("pointermove", 150, 100))
    setWidth(200)
    window.dispatchEvent(pointerEvent("pointerup", 150, 100))
    expect(api.viewportWidth.value).toBe(200)
    expect(api.page.value).toBe(1)
  })

  it("commits nothing when the viewport has no width", () => {
    const { api } = mountCarousel({ pageCount: 3, width: 0 })
    swipe(api, { x: 250, y: 100 }, { x: 10, y: 100 })
    expect(api.page.value).toBe(0)
  })
})

describe("gestures the carousel declines", () => {
  it("lets a vertical drag through to the page", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    api.onPointerDown(pointerEvent("pointerdown", 150, 300))
    window.dispatchEvent(pointerEvent("pointermove", 152, 100))
    expect(api.pointerId.value).toBeNull()
    expect(api.dragOffset.value).toBe(0)

    window.dispatchEvent(pointerEvent("pointermove", 10, 100))
    expect(api.page.value).toBe(0)
    expect(api.dragOffset.value).toBe(0)
  })

  it("ignores the gesture entirely while swiping is disabled", () => {
    const { api } = mountCarousel({ pageCount: 3, swipeDisabled: () => true })
    swipe(api, { x: 250, y: 100 }, { x: 10, y: 100 })
    expect(api.page.value).toBe(0)
    expect(api.pointerId.value).toBeNull()
  })

  it("ignores moves carrying a different pointer id", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    api.onPointerDown(pointerEvent("pointerdown", 250, 100, 1))
    window.dispatchEvent(pointerEvent("pointermove", 50, 100, 2))
    expect(api.dragOffset.value).toBe(0)
    expect(api.pointerId.value).toBe(1)
  })

  it("drops the gesture on pointercancel without changing page", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    api.onPointerDown(pointerEvent("pointerdown", 250, 100))
    window.dispatchEvent(pointerEvent("pointermove", 100, 100))
    window.dispatchEvent(pointerEvent("pointercancel", 100, 100))
    expect(api.page.value).toBe(1)
    expect(api.dragOffset.value).toBe(0)
    expect(api.pointerId.value).toBeNull()
  })

  it("stops following the pointer once the scope is disposed", () => {
    const { api, unmount } = mountCarousel({ pageCount: 3 })
    api.onPointerDown(pointerEvent("pointerdown", 250, 100))
    unmount()
    window.dispatchEvent(pointerEvent("pointermove", 50, 100))
    expect(api.dragOffset.value).toBe(0)
    expect(api.pointerId.value).toBeNull()
  })
})
