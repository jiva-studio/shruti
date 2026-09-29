import type { IAppLifecycle, IClipboard, IDeviceInfo } from "@ports/app/index.js"
import { useCapacitorAppLifecycle } from "./useCapacitorAppLifecycle.js"
import { useCapacitorClipboard } from "./useCapacitorClipboard.js"
import { useCapacitorDeviceInfo } from "./useCapacitorDeviceInfo.js"

export { useCapacitorAppLifecycle }

/** The Capacitor-backed platform ports stores and views ask for. */
export function useCapacitorPlatform(): {
  appLifecycle: IAppLifecycle
  deviceInfo: IDeviceInfo
  clipboard: IClipboard
} {
  return {
    appLifecycle: useCapacitorAppLifecycle(),
    deviceInfo: useCapacitorDeviceInfo(),
    clipboard: useCapacitorClipboard(),
  }
}
