import type { WindowBounds, Windowing, WindowingMode } from "../../ports/Windowing.js"
import type { Adb } from "./Adb.js"

/** WindowConfiguration.WINDOWING_MODE_* — the values `am start` accepts. */
const FULLSCREEN = 1
const MULTI_WINDOW = 6

const MODES: readonly WindowingMode[] = ["fullscreen", "multi-window", "freeform", "pinned"]

function rect(block: string, field: string): WindowBounds | null {
  const m = block.match(new RegExp(`${field}=Rect\\((\\d+), (\\d+) - (\\d+), (\\d+)\\)`))
  if (!m) return null
  return { width: Number(m[3]) - Number(m[1]), height: Number(m[4]) - Number(m[2]) }
}

export class AndroidWindowing implements Windowing {
  constructor(private readonly adb: Adb) {}

  /** The `cmd activity stack list` section describing the app's own root task. */
  private block(): string {
    const blocks = this.adb.shell("cmd activity stack list").split(/^RootTask /m)
    const mine = blocks.find((b) => b.includes(`: ${this.adb.appPackage}/`))
    if (!mine) throw new Error(`${this.adb.appPackage} has no task — is it running?`)
    return mine
  }

  private taskId(): number {
    const id = this.block().match(new RegExp(`taskId=(\\d+): ${this.adb.appPackage}/`))?.[1]
    if (!id) throw new Error(`no task id for ${this.adb.appPackage}`)
    return Number(id)
  }

  async mode(): Promise<WindowingMode> {
    const raw = this.block().match(/mWindowingMode=([a-z-]+)/)?.[1]
    return MODES.find((m) => m === raw) ?? "unknown"
  }

  async bounds(): Promise<WindowBounds> {
    const bounds = rect(this.block(), "mBounds")
    if (!bounds) throw new Error("the task reported no bounds")
    return bounds
  }

  async displayBounds(): Promise<WindowBounds> {
    // mMaxBounds is the display the task lives on and does not shrink with it.
    const bounds = rect(this.block(), "mMaxBounds")
    if (!bounds) throw new Error("the task reported no display bounds")
    return bounds
  }

  async enterSplitScreen(): Promise<void> {
    const display = await this.displayBounds()
    this.adb.shell(`am start --windowingMode ${MULTI_WINDOW} -n ${this.adb.component}`)
    await this.waitForMode("multi-window")

    // The mode alone leaves the task filling the display; the resize is what
    // actually hands the app a split-screen-sized window.
    const half = Math.round(display.height / 2)
    this.adb.shell(`cmd activity task resize ${this.taskId()} 0 0 ${display.width} ${half}`)
    await browser.waitUntil(async () => (await this.bounds()).height <= half, {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: "the app kept its full-height window",
    })
  }

  async leaveSplitScreen(): Promise<void> {
    this.adb.shell(`am start --windowingMode ${FULLSCREEN} -n ${this.adb.component}`)
    await this.waitForMode("fullscreen")
    const display = await this.displayBounds()
    await browser.waitUntil(async () => (await this.bounds()).height === display.height, {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: "the app never got the whole display back",
    })
  }

  private async waitForMode(mode: WindowingMode): Promise<void> {
    await browser.waitUntil(async () => (await this.mode()) === mode, {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `the app's window never became ${mode}`,
    })
  }
}
