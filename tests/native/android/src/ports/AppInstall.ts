/** The package on the device — what an uninstall takes with it and what it leaves. */
export interface AppInstall {
  install(): Promise<void>
  uninstall(): Promise<void>
  isInstalled(): Promise<boolean>
}
