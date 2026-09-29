import type { IClock } from "@lib/domain/ports/clock.js"

/** The device's wall clock. */
export const systemClock: IClock = {
  now: () => Date.now(),
}
