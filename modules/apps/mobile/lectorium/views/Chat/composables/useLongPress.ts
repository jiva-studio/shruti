import { onBeforeUnmount } from "vue"

export interface UseLongPressReturn {
  onPointerDown: () => void
  onPointerCancel: () => void
  /** True once, right after a long press fired — the caller swallows the
   *  trailing click so the press does not also act as a tap. */
  takeSuppressedClick: () => boolean
}

/** Holding a pointer down for `delayMs` fires `onLongPress`; lifting, leaving
 *  or cancelling before that disarms it. */
export function useLongPress(onLongPress: () => void, delayMs = 500): UseLongPressReturn {
  let timer: ReturnType<typeof setTimeout> | null = null
  let suppressClick = false

  function disarm(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  onBeforeUnmount(disarm)

  return {
    onPointerDown: () => {
      disarm()
      timer = setTimeout(() => {
        timer = null
        suppressClick = true
        onLongPress()
      }, delayMs)
    },
    onPointerCancel: disarm,
    takeSuppressedClick: () => {
      const was = suppressClick
      suppressClick = false
      return was
    },
  }
}
