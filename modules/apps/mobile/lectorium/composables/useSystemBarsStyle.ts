import { registerPlugin } from "@capacitor/core"
import { useLectorium } from "@lectorium/lectorium.js"

/**
 * Built-in Capacitor v6+ core plugin. Exposed in:
 *   android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java
 *   ios/Capacitor/Capacitor/Plugins/SystemBars.swift
 *
 * iOS ignores the `bar` argument and always toggles the status bar.
 * Android honours `bar = "StatusBar" | "NavigationBar"`. NavigationBar
 * controls the bottom system nav (back / home / recents on legacy 3-button
 * mode, the gesture pill on gesture nav).
 *
 * `style = "DARK"` means a *dark background* — i.e. icons are rendered
 * **light**. `"LIGHT"` is the inverse (light background, dark icons).
 * `"DEFAULT"` follows the system day/night setting.
 */
type SystemBarStyle = "DARK" | "LIGHT" | "DEFAULT"
type SystemBarTarget = "StatusBar" | "NavigationBar"

interface SystemBarsPlugin {
  setStyle(options: { bar?: SystemBarTarget; style: SystemBarStyle }): Promise<void>
}

const SystemBars = registerPlugin<SystemBarsPlugin>("SystemBars")

/**
 * Toggle the Android status & navigation bar icon colours so they stay
 * legible while the transcript modal — which paints its own dark
 * background that bleeds under the system bars — is on screen.
 *
 * No-op on iOS / web: the iOS modal already handles its own status-bar
 * appearance, and the bottom home-indicator adapts automatically. The
 * web build has no system bars to touch.
 *
 * The plugin doesn't expose a getter for the current style, so we
 * always restore to `DEFAULT` (system day/night). That matches what the
 * app uses at startup — no other call site overrides it — so it's a
 * safe restore point.
 */
export function useSystemBarsStyle(): {
  applyImmersive(): Promise<void>
  restoreDefault(): Promise<void>
} {
  const isAndroid = useLectorium().platform === "android"

  async function applyImmersive(): Promise<void> {
    if (!isAndroid) return
    try {
      // "DARK" = dark background, light icons — what the immersive
      // transcript surface needs against its dark fill.
      await SystemBars.setStyle({ bar: "StatusBar", style: "DARK" })
      await SystemBars.setStyle({ bar: "NavigationBar", style: "DARK" })
    } catch {
      // Plugin missing on older Capacitor versions or in tests — fail
      // silently; cosmetic regression only.
    }
  }

  async function restoreDefault(): Promise<void> {
    if (!isAndroid) return
    try {
      await SystemBars.setStyle({ bar: "StatusBar", style: "DEFAULT" })
      await SystemBars.setStyle({ bar: "NavigationBar", style: "DEFAULT" })
    } catch {
      // See note in applyImmersive.
    }
  }

  return { applyImmersive, restoreDefault }
}
