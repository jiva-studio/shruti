import { onBeforeUnmount, onMounted, ref, type Ref } from "vue"

export interface UseHorizontalCarouselOptions {
  readonly pageCount: number
  readonly initialPage?: number
  readonly viewportEl: () => HTMLElement | null
}

export interface UseHorizontalCarouselReturn {
  readonly page: Ref<number>
  readonly dragOffset: Ref<number>
  readonly pointerId: Ref<number | null>
  readonly viewportWidth: Ref<number>
  readonly onPointerDown: (e: PointerEvent) => void
  goTo: (index: number) => void
}

const DRAG_LOCK_THRESHOLD = 8
const PAGE_SWITCH_THRESHOLD = 0.2
const OUT_OF_BOUNDS_RESISTANCE = 0.3

export function useHorizontalCarousel(
  options: UseHorizontalCarouselOptions
): UseHorizontalCarouselReturn {
  const initial = clamp(options.initialPage ?? 0, 0, options.pageCount - 1)
  const page = ref<number>(initial)
  const dragOffset = ref<number>(0)
  const pointerId = ref<number | null>(null)
  const viewportWidth = ref<number>(0)

  let gestureOriginX = 0
  let gestureOriginY = 0
  let dragLocked: "horizontal" | "vertical" | null = null
  let resizeObserver: ResizeObserver | null = null

  function measure(): void {
    const el = options.viewportEl()
    if (el) viewportWidth.value = el.getBoundingClientRect().width
  }

  onMounted(() => {
    const el = options.viewportEl()
    measure()
    if (el && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(measure)
      resizeObserver.observe(el)
    }
  })

  function onPointerDown(e: PointerEvent): void {
    pointerId.value = e.pointerId
    gestureOriginX = e.clientX
    gestureOriginY = e.clientY
    dragLocked = null
    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerUp)
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== pointerId.value) return
    const dx = e.clientX - gestureOriginX
    const dy = e.clientY - gestureOriginY
    if (dragLocked === null) {
      if (Math.abs(dx) < DRAG_LOCK_THRESHOLD && Math.abs(dy) < DRAG_LOCK_THRESHOLD) return
      // Vertical wins → let the page scroll natively; horizontal drives the carousel.
      dragLocked = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical"
      if (dragLocked === "vertical") {
        cleanup()
        return
      }
    }
    let offset = dx
    if (page.value === 0 && dx > 0) offset = dx * OUT_OF_BOUNDS_RESISTANCE
    if (page.value === options.pageCount - 1 && dx < 0) {
      offset = dx * OUT_OF_BOUNDS_RESISTANCE
    }
    dragOffset.value = offset
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerId !== pointerId.value) return
    if (dragLocked === "horizontal") {
      measure()
      const w = viewportWidth.value
      if (w > 0) {
        const ratio = dragOffset.value / w
        if (ratio < -PAGE_SWITCH_THRESHOLD && page.value < options.pageCount - 1) page.value += 1
        else if (ratio > PAGE_SWITCH_THRESHOLD && page.value > 0) page.value -= 1
      }
    }
    dragOffset.value = 0
    cleanup()
  }

  function cleanup(): void {
    pointerId.value = null
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerup", onPointerUp)
    window.removeEventListener("pointercancel", onPointerUp)
  }

  function goTo(index: number): void {
    page.value = clamp(index, 0, options.pageCount - 1)
  }

  onBeforeUnmount(() => {
    cleanup()
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  return { page, dragOffset, pointerId, viewportWidth, onPointerDown, goTo }
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return n
}
