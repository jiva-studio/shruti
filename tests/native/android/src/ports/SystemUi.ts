export type Orientation = "PORTRAIT" | "LANDSCAPE"

export interface SystemUi {
  rotate(to: Orientation): Promise<void>
  pressBack(): Promise<void>
  /** The headset / bluetooth play-pause key, delivered as a real media button. */
  pressMediaPlayPause(): Promise<void>
  isKeyboardShown(): Promise<boolean>
  setNightMode(on: boolean): Promise<void>
}
