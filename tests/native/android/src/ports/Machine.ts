/** The machine under the app. A power cycle is the one thing a test cannot
 *  fake: only a real boot shows what the OS restores on its own. */
export interface Machine {
  isBooted(): Promise<boolean>
  /** Reboot, and return once the device is up and usable again. */
  reboot(timeoutMs?: number): Promise<void>
}
