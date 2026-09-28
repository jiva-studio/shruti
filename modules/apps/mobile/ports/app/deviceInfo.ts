/** The installed build, as the store listing numbers it. */
export interface AppVersion {
  readonly version: string
  readonly build: string
}

/**
 * What the device and the installed app say about themselves. Both reads
 * reject where the platform cannot answer (the web build has no native app
 * info), and the caller chooses its own fallback.
 */
export interface IDeviceInfo {
  /** The platform's stable per-install device identifier. */
  getId(): Promise<string>
  getAppVersion(): Promise<AppVersion>
}
