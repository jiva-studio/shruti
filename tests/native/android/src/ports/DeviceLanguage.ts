/** The language the OS hands the app — the same setting Android's own
 *  "App language" screen writes. */
export interface DeviceLanguage {
  /** The language tag in force, or null while the app follows the device. */
  current(): Promise<string | null>
  set(tag: string): Promise<void>
  /** Back to following the device. */
  clear(): Promise<void>
}
