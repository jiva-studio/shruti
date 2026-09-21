// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { createApp, defineComponent, h, type App } from "vue"
import { useVerticalCarousel, type UseVerticalCarouselReturn } from "../useVerticalCarousel.js"

const VIEWPORT_HEIGHT = 400

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
})

/** Mount the composable inside a component so `onBeforeUnmount` is live. */
function mountCarousel(options: {
  pageCount: number
  initialPage?: number
  viewportHeight?: number
}): { api: UseVerticalCarouselReturn; unmount: () => void } {
  const height = options.viewportHeight ?? VIEWPORT_HEIGHT
  const viewport = document.createElement("div")
  viewport.getBoundingClientRect = () => ({ height }) as DOMRect

  let api: UseVerticalCarouselReturn | null = null
  const Host = defineComponent({
    setup() {
      api = useVerticalCarousel({
        pageCount: options.pageCount,
        initialPage: options.initialPage,
        viewportEl: () => viewport,
      })
      return () => h("div")
    },
  })
  const root = document.createElement("div")
  document.body.appendChild(root)
  app = createApp(Host)
  app.mount(root)
  return {
    api: api as unknown as UseVerticalCarouselReturn,
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

/** One complete gesture: down at the origin, a move, then up. */
function swipe(
  api: UseVerticalCarouselReturn,
  from: { x: number; y: number },
  to: { x: number; y: number },
  pointerId = 1
): void {
  api.onPointerDown(pointerEvent("pointerdown", from.x, from.y, pointerId))
  window.dispatchEvent(pointerEvent("pointermove", to.x, to.y, pointerId))
  window.dispatchEvent(pointerEvent("pointerup", to.x, to.y, pointerId))
}

describe("initial page", () => {
  it("starts on page 0 when no page is asked for", () => {
    expect(mountCarousel({ pageCount: 3 }).api.page.value).toBe(0)
  })

  it("clamps a page beyond the last one", () => {
    expect(mountCarousel({ pageCount: 3, initialPage: 9 }).api.page.value).toBe(2)
  })

  it("clamps a negative page to the first", () => {
    expect(mountCarousel({ pageCount: 3, initialPage: -4 }).api.page.value).toBe(0)
  })
})

describe("vertical swipes", () => {
  it("advances a page on a drag past the commit threshold", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    swipe(api, { x: 50, y: 300 }, { x: 50, y: 150 })
    expect(api.page.value).toBe(1)
    expect(api.dragOffset.value).toBe(0)
    expect(api.pointerId.value).toBeNull()
  })

  it("goes back a page on a downward drag", () => {
    const { api } = mountCarousel({ pageCount: 3, initialPage: 2 })
    swipe(api, { x: 50, y: 100 }, { x: 50, y: 250 })
    expect(api.page.value).toBe(1)
  })

  it("snaps back when the drag stops short of the threshold", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    // 50px of 400 is 0.125 — under the 0.25 commit fraction.
    swipe(api, { x: 50, y: 300 }, { x: 50, y: 250 })
    expect(api.page.value).toBe(0)
    expect(api.dragOffset.value).toBe(0)
  })

  it("tracks the offset while the finger is down", () => {
    const { api } = mountCarousel({ pageCount: 3, initialPage: 1 })
    api.onPointerDown(pointerEvent("pointerdown", 50, 300))
    expect(api.pointerId.value).toBe(1)
    window.dispatchEvent(pointerEvent("pointermove", 50, 240))
    expect(api.dragOffset.value).toBe(-60)
  })

  it("resists a drag past the last page", () => {
    const { api } = mountCarousel({ pageCount: 2, initialPage: 1 })
    api.onPointerDown(pointerEvent("pointerdown", 50, 300))
    window.dispatchEvent(pointerEvent("pointermove", 50, 200))
    // Beyond the end the travel is damped rather than followed 1:1.
    expect(api.dragOffset.value).toBeGreaterThan(-100)
    expect(api.dragOffset.value).toBeLessThan(0)
  })

  it("stays on the last page however far the drag goes", () => {
    const { api } = mountCarousel({ pageCount: 2, initialPage: 1 })
    swipe(api, { x: 50, y: 350 }, { x: 50, y: 10 })
    expect(api.page.value).toBe(1)
  })

  it("stays on the first page when dragged down from it", () => {
    const { api } = mountCarousel({ pageCount: 2 })
    swipe(api, { x: 50, y: 10 }, { x: 50, y: 350 })
    expect(api.page.value).toBe(0)
  })
})

describe("gestures the carousel declines", () => {
  it("ignores a horizontal drag and leaves the page alone", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    api.onPointerDown(pointerEvent("pointerdown", 50, 300))
    window.dispatchEvent(pointerEvent("pointermove", 250, 305))
    expect(api.pointerId.value).toBeNull()
    expect(api.dragOffset.value).toBe(0)
    // Further movement after the bail must not resurrect the drag.
    window.dispatchEvent(pointerEvent("pointermove", 250, 100))
    expect(api.dragOffset.value).toBe(0)
    expect(api.page.value).toBe(0)
  })

  it("ignores moves carrying a different pointer id", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    api.onPointerDown(pointerEvent("pointerdown", 50, 300, 1))
    window.dispatchEvent(pointerEvent("pointermove", 50, 100, 2))
    expect(api.dragOffset.value).toBe(0)
    expect(api.pointerId.value).toBe(1)
  })

  it("holds the drag when a foreign pointer is lifted", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    api.onPointerDown(pointerEvent("pointerdown", 50, 300, 1))
    window.dispatchEvent(pointerEvent("pointermove", 50, 150, 1))
    window.dispatchEvent(pointerEvent("pointerup", 50, 150, 2))
    expect(api.pointerId.value).toBe(1)
    expect(api.page.value).toBe(0)
  })

  it("drops the gesture on pointercancel without changing page", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    api.onPointerDown(pointerEvent("pointerdown", 50, 300))
    window.dispatchEvent(pointerEvent("pointermove", 50, 150))
    window.dispatchEvent(pointerEvent("pointercancel", 50, 150))
    expect(api.dragOffset.value).toBe(0)
    expect(api.pointerId.value).toBeNull()
  })

  it("commits nothing when the viewport has no height", () => {
    const { api } = mountCarousel({ pageCount: 3, viewportHeight: 0 })
    swipe(api, { x: 50, y: 300 }, { x: 50, y: 10 })
    expect(api.page.value).toBe(0)
  })
})

describe("swipe-versus-tap suppression", () => {
  it("reports the last gesture once and then forgets it", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    swipe(api, { x: 50, y: 300 }, { x: 50, y: 150 })
    expect(api.consumeVerticalGesture()).toBe(true)
    expect(api.consumeVerticalGesture()).toBe(false)
  })

  it("reports nothing for a tap that never moved", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    api.onPointerDown(pointerEvent("pointerdown", 50, 300))
    window.dispatchEvent(pointerEvent("pointerup", 50, 300))
    expect(api.consumeVerticalGesture()).toBe(false)
  })

  it("reports a vertical gesture even when it snapped back", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    swipe(api, { x: 50, y: 300 }, { x: 50, y: 270 })
    expect(api.page.value).toBe(0)
    expect(api.consumeVerticalGesture()).toBe(true)
  })

  it("reports nothing after a horizontal drag", () => {
    const { api } = mountCarousel({ pageCount: 3 })
    swipe(api, { x: 50, y: 300 }, { x: 250, y: 302 })
    expect(api.consumeVerticalGesture()).toBe(false)
  })
})

describe("listener cleanup", () => {
  it("stops following the pointer once the scope is disposed", () => {
    const { api, unmount } = mountCarousel({ pageCount: 3 })
    api.onPointerDown(pointerEvent("pointerdown", 50, 300))
    unmount()
    window.dispatchEvent(pointerEvent("pointermove", 50, 100))
    expect(api.dragOffset.value).toBe(0)
    expect(api.pointerId.value).toBeNull()
  })
})
