import { onScopeDispose, ref, type Ref } from "vue"

export interface DragRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface UseDragPumpOptions {
  /**
   * Returns the DOM element whose bounding rect anchors the drag
   * coordinates (typically the rail / track, not the puck). Re-queried
   * on every pointerdown so layout shifts between drags are picked up.
   */
  readonly trackEl: () => HTMLElement | null
  /**
   * Called once on pointerdown (with the press coordinates) and on every
   * pointermove while a drag is active. The rect snapshot taken at
   * pointerdown is passed through so handlers don't have to call
   * getBoundingClientRect themselves.
   */
  readonly onMove: (clientX: number, clientY: number, rect: DragRect) => void
  /** Called once when the drag ends (pointerup or pointercancel). */
  readonly onCommit?: () => void
  /**
   * Stop propagation on the pointerdown event so parent gestures (e.g. a
   * page-swipe carousel) don't claim the same drag. Defaults to `true`
   * since both extracted call sites need it.
   */
  readonly stopPropagation?: boolean
}

export interface UseDragPumpReturn {
  readonly dragging: Ref<boolean>
  /** Wire to the puck / drag-handle's `pointerdown` event. */
  readonly onPointerDown: (e: PointerEvent) => void
}

/**
 * Reusable pointer-drag pump. Captures the pointer, snapshots the
 * drag-anchor rect, forwards move events through `onMove`, and tears
 * down its `window` listeners on pointerup, pointercancel, or scope
 * dispose.
 *
 * Used by speed/mix sliders and the floating-player vertical carousel
 * — all three previously copied the same pointerdown/move/up
 * boilerplate. Consumers supply just the value-mapping math (`onMove`)
 * and the commit hook.
 */
export function useDragPump(options: UseDragPumpOptions): UseDragPumpReturn {
  const dragging = ref(false)
  let pointerId: number | null = null
  let rect: DragRect = { left: 0, top: 0, width: 0, height: 0 }

  function dispatch(clientX: number, clientY: number): void {
    options.onMove(clientX, clientY, rect)
  }

  function move(e: PointerEvent): void {
    if (!dragging.value || e.pointerId !== pointerId) return
    dispatch(e.clientX, e.clientY)
  }

  function end(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return
    teardown()
    options.onCommit?.()
  }

  function teardown(): void {
    dragging.value = false
    pointerId = null
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", end)
    window.removeEventListener("pointercancel", end)
  }

  function onPointerDown(e: PointerEvent): void {
    const el = options.trackEl()
    if (!el) return
    const r = el.getBoundingClientRect()
    rect = { left: r.left, top: r.top, width: r.width, height: r.height }
    pointerId = e.pointerId
    dragging.value = true
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dispatch(e.clientX, e.clientY)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
    if (options.stopPropagation !== false) e.stopPropagation()
  }

  // If the consumer unmounts mid-drag, drop the global listeners so the
  // dead component doesn't keep receiving pointer events.
  onScopeDispose(teardown)

  return { dragging, onPointerDown }
}
