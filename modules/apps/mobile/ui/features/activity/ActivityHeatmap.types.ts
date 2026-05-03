/** A single day cell in the activity heatmap. */
export interface ActivityHeatmapDay {
  /** ISO date string "YYYY-MM-DD" in local timezone. */
  readonly date: string
  /** Total seconds listened on this day. */
  readonly listenedSeconds: number
  /** True for the cell representing the current local-day. */
  readonly isToday: boolean
}

export interface ActivityHeatmapProps {
  /** Pre-built grid of cells, oldest first. Lay out as 7 rows × N columns. */
  readonly days: readonly ActivityHeatmapDay[]
  /** Number of grid rows. Default 7 (one per day of the week). */
  readonly rows?: number
}
