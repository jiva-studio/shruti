export type Orientation = "PORTRAIT" | "LANDSCAPE"

export interface SystemUi {
  rotate(to: Orientation): Promise<void>
  pressBack(): Promise<void>
  /** The headset / bluetooth play-pause key, delivered as a real media button. */
  pressMediaPlayPause(): Promise<void>
  setScreenOn(on: boolean): Promise<void>
  isScreenOn(): Promise<boolean>
  isKeyboardShown(): Promise<boolean>
  setNightMode(on: boolean): Promise<void>
  setFontScale(scale: number): Promise<void>
}
