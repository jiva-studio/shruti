/**
 * One cell of the generic heatmap grid. `fill` is a resolved CSS color the
 * consuming app supplies (typically `var(--heatmap-...)`) — kit never owns the
 * colour vocabulary, so single-track (listened) and dual-track
 * (reviewed/scheduled) apps both map their own intensity → fill.
 */
export interface HeatmapCell {
  fill: string
  today?: boolean
}
