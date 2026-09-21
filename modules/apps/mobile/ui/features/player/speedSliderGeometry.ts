/** Half-width of the puck pill in px. The rail/tick CSS insets match it, so the
 *  puck never overflows the slider's footprint at the extreme presets. */
export const PUCK_HALF = 10

/** Where, in [0, 1], a rate sits on the rail. Linear in rate-space is fine for
 *  six presets — 1×→1.25× reads like 1.5×→1.75×. */
export function presetLeftFraction(rate: number, min: number, max: number): number {
  return (rate - min) / (max - min)
}

/** Centre of the rail at `fraction`, as a CSS calc() pinned to the inner range. */
export function leftCalc(fraction: number): string {
  return `calc(${PUCK_HALF}px + (100% - ${PUCK_HALF * 2}px) * ${fraction})`
}

/** The fraction of the inner rail a pointer at `clientX` is over. */
export function fractionFromClientX(clientX: number, left: number, width: number): number {
  const innerWidth = Math.max(1, width - PUCK_HALF * 2)
  return Math.max(0, Math.min(1, (clientX - left - PUCK_HALF) / innerWidth))
}

export function findNearestPreset(value: number, presets: readonly number[]): number {
  let best = presets[0]!
  let bestDist = Math.abs(value - best)
  for (const p of presets) {
    const d = Math.abs(value - p)
    if (d < bestDist) {
      best = p
      bestDist = d
    }
  }
  return best
}

/** Tick labels are bare numbers — six labels plus "×" would not fit on a narrow
 *  screen, and the player chrome makes the multiplier read implicit. */
export function formatRate(rate: number): string {
  if (Number.isInteger(rate)) return `${rate}`
  return rate.toString().replace(/\.0+$/, "")
}
