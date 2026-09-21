export interface ScrollRect {
  top: number
  bottom: number
  height: number
}

// Bottom comfort band as a fraction of host height. Kept high so the active
// block drifts well into the lower viewport before being re-snapped — moving
// it earlier reads as jumpy and forces the reader to refocus.
const BOTTOM_BAND = 0.9
// Where the block lands when we do scroll: a small gap from the top, so the
// reader sees mostly upcoming content. Teleprompter style.
const UPPER_OFFSET_FRACTION = 0.1
// A position that drops nearly to zero from well past it is a mid-seek
// transient, not a real playhead move.
const TRANSIENT_NEAR_ZERO_MS = 500
const TRANSIENT_PREV_MIN_MS = 1000

export function isInViewport(host: ScrollRect, el: ScrollRect): boolean {
  return el.bottom > host.top && el.top < host.bottom
}

export function isDriftingOffBottom(host: ScrollRect, el: ScrollRect): boolean {
  return (el.bottom - host.top) / host.height > BOTTOM_BAND
}

export function scrollTargetTop(host: ScrollRect, el: ScrollRect, scrollTop: number): number {
  const elTopInScroll = el.top - host.top + scrollTop
  return Math.max(0, elTopInScroll - host.height * UPPER_OFFSET_FRACTION)
}

/** A `progress ≈ 0` emitted between the old position and the real seek target. */
export function isSeekTransient(prevPosition: number, newPosition: number): boolean {
  return newPosition < TRANSIENT_NEAR_ZERO_MS && prevPosition - newPosition > TRANSIENT_PREV_MIN_MS
}

/** Are `prev` and `next` consecutive transcript blocks? Walks over siblings that
 *  are not blocks — a chapter heading sits BETWEEN two paragraphs, and counting
 *  it as a gap made every chapter boundary look like a seek. */
export function isAdjacentBlock(
  prev: HTMLElement | null,
  next: HTMLElement,
  blockSelector: string
): boolean {
  if (!prev) return false
  let el = prev.nextElementSibling
  while (el !== null && el !== next && !el.matches(blockSelector)) {
    el = el.nextElementSibling
  }
  return el === next
}
