import type { IHaptics } from "@ports/app/haptics.js"

/**
 * Pure no-op `IHaptics` for the web build. The Web Vibration API is too
 * inconsistent across browsers to model as haptic feedback, and the app
 * treats haptics as a purely native affordance.
 */
export function useWebHaptics(): IHaptics {
  return {
    async impact() {
      // No-op on web.
    },
  }
}
