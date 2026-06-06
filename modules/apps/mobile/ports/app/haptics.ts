/**
 * Port over platform haptic feedback. Web has no equivalent API, so
 * the web adapter is a pure no-op. Keeps `@capacitor/haptics` out of
 * views, controllers, and UI components.
 *
 * The port lives in the shared kit (`@kit/infra`); re-exported here so app
 * code keeps importing it from `@ports/app`.
 */
export type { IHaptics, HapticImpactStyle } from "@kit/infra"
