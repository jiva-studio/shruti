import { Haptics, ImpactStyle } from "@capacitor/haptics"
import type { HapticImpactStyle, IHaptics } from "@ports/app/haptics.js"

const STYLE_MAP: Record<HapticImpactStyle, ImpactStyle> = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy,
}

/**
 * `IHaptics` backed by `@capacitor/haptics`. The plugin itself no-ops on
 * platforms without haptic hardware, so any error from the bridge is
 * swallowed to keep the call fire-and-forget.
 */
export function useCapacitorHaptics(): IHaptics {
  return {
    async impact(style) {
      try {
        await Haptics.impact({ style: STYLE_MAP[style] })
      } catch {
        // Non-fatal: plugin not installed, platform has no haptics, etc.
      }
    },
  }
}
