import type { CutoutShape, DisplayCutout } from "../../ports/DisplayCutout.js"
import type { Adb } from "./Adb.js"

const OVERLAY_PREFIX = "com.android.internal.display.cutout.emulation."
const ENABLED_CUTOUT = /^\s*\[x\]\s*(com\.android\.internal\.display\.cutout\.emulation\.\S+)/gm
const TOP_INSET = /mDisplayCutout=DisplayCutout\{insets=Rect\(\s*-?\d+,\s*(-?\d+)\s*-/

export class AndroidDisplayCutout implements DisplayCutout {
  constructor(private readonly adb: Adb) {}

  async enable(shape: CutoutShape): Promise<void> {
    this.adb.shell(`cmd overlay enable ${OVERLAY_PREFIX}${shape}`)
    await this.settled((px) => px > 0, `the display never reported a ${shape} cutout`)
  }

  /**
   * Drops every emulated cutout, not just ours — a run that died mid-spec
   * leaves one behind and the next one must not inherit it. The AVD's own
   * notch stays: the device profile the emulator boots is a phone with a
   * punch-hole, so the display never reports zero and this settles on that
   * baseline instead.
   */
  async disable(): Promise<void> {
    for (const name of this.emulated()) this.adb.shell(`cmd overlay disable ${name}`)
    await browser.waitUntil(async () => this.emulated().length === 0, {
      timeout: 30_000,
      interval: 1_000,
      timeoutMsg: "an emulated cutout stayed enabled",
    })
    await this.settled(() => true, "the display never settled after the overlays came off")
  }

  async topInsetPx(): Promise<number> {
    return Number(this.adb.shell("dumpsys window displays").match(TOP_INSET)?.[1] ?? 0)
  }

  private emulated(): string[] {
    return [...this.adb.shell("cmd overlay list").matchAll(ENABLED_CUTOUT)].map((m) => m[1]!)
  }

  /**
   * Swapping an overlay walks the display through sizes it settles away from
   * again (126 → 128), so a single sample can be a value from mid-flight. Wait
   * for two identical readings that also satisfy `accepts`.
   */
  private async settled(accepts: (px: number) => boolean, message: string): Promise<void> {
    let previous = NaN
    await browser.waitUntil(
      async () => {
        const px = await this.topInsetPx()
        const stable = px === previous && accepts(px)
        previous = px
        return stable
      },
      { timeout: 30_000, interval: 1_000, timeoutMsg: message },
    )
  }
}
