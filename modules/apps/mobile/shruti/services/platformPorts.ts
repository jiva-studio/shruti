import type { IAppLifecycle, IClipboard, IDeviceInfo } from "@ports/app/index.js"

/** The platform services a store or a view may ask for, instead of a native plugin. */
export interface PlatformPorts {
  readonly appLifecycle: IAppLifecycle
  readonly deviceInfo: IDeviceInfo
  readonly clipboard: IClipboard
}
