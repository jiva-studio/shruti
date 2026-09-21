import { onBeforeUnmount, ref, type Ref } from "vue"
import { lockDragAxis, resistOutOfBounds, type DragAxis } from "@ui/components/carouselDrag.js"

export interface UseVerticalCarouselOptions {
  readonly pageCount: number
  /** Index to land on when the consumer mounts. Clamped to pageCount-1. */
  readonly initialPage?: number
  /** Returns the element whose height is the per-page travel distance. */
  readonly viewportEl: () => HTMLElement | null
}

export interface UseVerticalCarouselReturn {
  readonly page: Ref<number>
  readonly dragOffset: Ref<number>
  /** `null` when no drag is in flight. Useful for "snap" CSS transitions. */
  readonly pointerId: Ref<number | null>
  /** Wire to the carousel root's `pointerdown`. */
  readonly onPointerDown: (e: PointerEvent) => void
  /**
   * Returns `true` and self-resets when the most recent gesture was a
   * vertical drag — used by the consumer's `onClick` to suppress the
   * synthesised tap that follows a swipe.
   */
  readonly consumeVerticalGesture: () => boolean
}

const DRAG_LOCK_THRESHOLD = 8 // px before deciding direction
const PAGE_SWITCH_THRESHOLD = 0.25 // fraction of viewport height to commit a page change
const OUT_OF_BOUNDS_RESISTANCE = 0.3 // multiplier for off-axis drag beyond first/last page

/**
 * Reactive page-state + pointer-driven vertical paging for the
 * FloatingPlayer carousel. Extracted from FloatingPlayer.vue so:
 * - the pointer cleanup contract (always remove window listeners on
 *   pointer-up / pointer-cancel / scope-dispose) lives in one place,
 * - the consumer template stays declarative (`page`, `dragOffset`,
 *   `pointerId`, plus an `onPointerDown` handler),
 * - the "swipe vs tap" suppression now flows through
 *   `consumeVerticalGesture()` instead of the consumer poking back
 *   into the composable's state to clear a lock flag.
 *
 * The direction-lock decides between horizontal and vertical on the
 * first 8 px of travel: horizontal gestures bail immediately (an inner
 * slider may want them); vertical takes ownership and continues until
 * pointer-up.
 */
export function useVerticalCarousel(
  options: UseVerticalCarouselOptions
): UseVerticalCarouselReturn {
  const initial = clamp(options.initialPage ?? 0, 0, options.pageCount - 1)
  const page = ref<number>(initial)
  const dragOffset = ref<number>(0)
  const pointerId = ref<number | null>(null)

  // Snapshot at pointerdown; never read on its own.
  let gestureOriginX = 0
  let gestureOriginY = 0
  let dragLocked: DragAxis | null = null
  let lastGestureWasVertical = false

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
      // Vertical swipe drives the carousel. Horizontal: leave it alone —
      // an inner slider may want it (mix puck, speed puck), and any other
      // horizontal drag is just noise.
      dragLocked = lockDragAxis(dx, dy, DRAG_LOCK_THRESHOLD, "vertical")
      if (dragLocked === null) return
      if (dragLocked === "horizontal") {
        cleanup()
        return
      }
    }
    dragOffset.value = resistOutOfBounds(
      dy,
      page.value,
      options.pageCount,
      OUT_OF_BOUNDS_RESISTANCE
    )
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerId !== pointerId.value) return
    if (dragLocked === "vertical") {
      const viewport = options.viewportEl()
      const h = viewport?.getBoundingClientRect().height ?? 0
      if (h > 0) {
        const ratio = dragOffset.value / h
        if (ratio < -PAGE_SWITCH_THRESHOLD && page.value < options.pageCount - 1) page.value += 1
        else if (ratio > PAGE_SWITCH_THRESHOLD && page.value > 0) page.value -= 1
      }
      lastGestureWasVertical = true
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

  function consumeVerticalGesture(): boolean {
    const was = lastGestureWasVertical
    lastGestureWasVertical = false
    return was
  }

  onBeforeUnmount(cleanup)

  return { page, dragOffset, pointerId, onPointerDown, consumeVerticalGesture }
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return n
}
