export type CutoutShape = "corner" | "double" | "hole" | "tall" | "waterfall"

/** The notch the display claims to have — what forces the app off the top edge. */
export interface DisplayCutout {
  enable(shape: CutoutShape): Promise<void>
  /** Back to the notch the device itself has, which on a phone is not none. */
  disable(): Promise<void>
  /** Height of the cutout's top inset in device pixels, as the display reports it. */
  topInsetPx(): Promise<number>
}
