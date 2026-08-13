/** Battery and idle state — what the OS does to background work. */
export interface Power {
  unplug(): Promise<void>
  resetBattery(): Promise<void>
  forceDoze(): Promise<void>
  wake(): Promise<void>
}
