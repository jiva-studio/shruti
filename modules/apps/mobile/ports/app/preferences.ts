/**
 * Key-value persistence for lightweight app settings.
 *
 * The port and its adapters live in the shared kit (`@kit/infra`); this
 * module just re-exports the generic interface so app code keeps importing
 * it from `@ports/app`.
 */
export type { IPreferences } from "@kit/infra"
