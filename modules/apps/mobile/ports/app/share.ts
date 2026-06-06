/**
 * Port over the native share sheet (@capacitor/share on mobile,
 * Web Share API on the browser when available) and the platform
 * clipboard. Keeps platform-specific sharing concerns out of views.
 *
 * The port lives in the shared kit (`@kit/infra`); re-exported here so app
 * code keeps importing it from `@ports/app`.
 */
export type { IShareService, ShareOptions } from "@kit/infra"
