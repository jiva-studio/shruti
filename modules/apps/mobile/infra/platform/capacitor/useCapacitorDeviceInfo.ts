import type { IDeviceInfo } from "@ports/app/index.js"

/**
 * {@link IDeviceInfo} over `@capacitor/device` and `@capacitor/app`, loaded on
 * first use so neither plugin is pulled into startup for a support screen.
 */
export function useCapacitorDeviceInfo(): IDeviceInfo {
  return {
    async getId() {
      const { Device } = await import("@capacitor/device")
      return (await Device.getId()).identifier
    },
    async getAppVersion() {
      const { App } = await import("@capacitor/app")
      const info = await App.getInfo()
      return { version: info.version, build: info.build }
    },
  }
}
