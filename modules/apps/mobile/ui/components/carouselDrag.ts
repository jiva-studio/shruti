export type DragAxis = "horizontal" | "vertical"

/**
 * Which axis owns the gesture, or `null` while neither has travelled far
 * enough to decide. A tie goes to the axis the carousel does NOT own, so an
 * ambiguous drag is left to whatever else wants it.
 */
export function lockDragAxis(
  dx: number,
  dy: number,
  threshold: number,
  owned: DragAxis
): DragAxis | null {
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null
  const alongOwned = owned === "horizontal" ? Math.abs(dx) : Math.abs(dy)
  const alongOther = owned === "horizontal" ? Math.abs(dy) : Math.abs(dx)
  return alongOwned > alongOther ? owned : otherAxis(owned)
}

/** Damps a drag that pulls past the first or the last page. */
export function resistOutOfBounds(
  delta: number,
  page: number,
  pageCount: number,
  resistance: number
): number {
  const beforeFirst = page === 0 && delta > 0
  const pastLast = page === pageCount - 1 && delta < 0
  return beforeFirst || pastLast ? delta * resistance : delta
}

function otherAxis(axis: DragAxis): DragAxis {
  return axis === "horizontal" ? "vertical" : "horizontal"
}
