import type { HeatmapDay } from "./buildHeatmapDays.js"

/**
 * Number of consecutive days ending at "today" (or yesterday if today
 * has no activity yet) where the user listened to at least something.
 * Operates on a pre-built heatmap grid so the calling code doesn't need
 * to know the date arithmetic.
 */
export function computeCurrentStreak(days: readonly HeatmapDay[]): number {
  const todayIdx = days.findIndex((d) => d.isToday)
  if (todayIdx < 0) return 0

  let streak = 0
  let i = todayIdx
  // If nothing was listened today, the streak still counts from
  // yesterday — otherwise the badge would flicker to 0 every midnight.
  if (days[i].listenedSeconds === 0) i--

  while (i >= 0 && days[i].listenedSeconds > 0) {
    streak++
    i--
  }
  return streak
}
