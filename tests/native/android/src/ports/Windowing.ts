export type WindowingMode = "fullscreen" | "multi-window" | "freeform" | "pinned" | "unknown"

export interface WindowBounds {
  readonly width: number
  readonly height: number
}

/** The window the system hands the app: its mode and its size in device pixels. */
export interface Windowing {
  mode(): Promise<WindowingMode>
  bounds(): Promise<WindowBounds>
  /** The whole display, so a spec can say how much of it the app got. */
  displayBounds(): Promise<WindowBounds>
  /** Half-height multi-window — the window split screen leaves an app with. */
  enterSplitScreen(): Promise<void>
  leaveSplitScreen(): Promise<void>
}
