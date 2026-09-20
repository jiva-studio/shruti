import type { IHaptics } from "./haptics.js"

/**
 * Pure no-op {@link IHaptics} for the web build. The Web Vibration API
 * is too inconsistent across browsers to model as haptic feedback, so
 * haptics are treated as a purely native affordance.
 */
export function useWebHaptics(): IHaptics {
  return {
    async impact() {
      // No-op on web.
    },
  }
}
