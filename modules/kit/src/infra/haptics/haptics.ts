/**
 * Port over platform haptic feedback. Web has no consistent equivalent
 * API, so the web adapter is a pure no-op. Keeps `@capacitor/haptics`
 * out of views, controllers, and UI components.
 */
export type HapticImpactStyle = "light" | "medium" | "heavy"

export interface IHaptics {
  /** Trigger a physical haptic impact. No-op on platforms without haptics. */
  impact(style: HapticImpactStyle): Promise<void>
}
