import { test, expect, type Page } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { playFirstQueuedTrack } from "../support/nav.js"

const MIX_KEY = "CapacitorStorage.settings.audio.mixPosition"

/** Drive the stereo-mix puck to `xFraction` of the track width with synthetic
 *  pointer events. `applyFromClientX` only reads the track's x-rect, so the
 *  carousel page need not be revealed. */
async function dragMix(page: Page, xFraction: number): Promise<void> {
  const slider = page.locator(".mix-control")
  const box = await slider.locator(".track").boundingBox()
  if (!box) throw new Error("mix track has no box")
  const targetX = box.x + box.width * xFraction
  const y = box.y + box.height / 2
  await slider.locator(".puck").evaluate(
    (el, { tx, yy }) => {
      const proto = Element.prototype as unknown as { setPointerCapture: (id: number) => void }
      const orig = proto.setPointerCapture
      proto.setPointerCapture = () => {}
      const o = (x: number) => ({ pointerId: 1, clientX: x, clientY: yy, bubbles: true })
      el.dispatchEvent(new PointerEvent("pointerdown", o((el as HTMLElement).getBoundingClientRect().x)))
      window.dispatchEvent(new PointerEvent("pointermove", o(tx)))
      window.dispatchEvent(new PointerEvent("pointerup", o(tx)))
      proto.setPointerCapture = orig
    },
    { tx: targetX, yy: y }
  )
}

const mixValue = (page: Page) =>
  page.evaluate((k) => Number(localStorage.getItem(k)), MIX_KEY)

// Dragging the puck well off-centre engages the mix; the position is a global
// audio config that survives a restart (and applies to every track).
test(
  qase(72, "Mix setting persists across tracks and restarts"),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)
    await playFirstQueuedTrack(page)

    // Drag to ~+0.6 (x-fraction 0.8) — well past the ±0.15 deadzone.
    await dragMix(page, 0.8)
    await expect.poll(() => mixValue(page), { timeout: 10_000 }).toBeGreaterThan(0.15)
    const engaged = await mixValue(page)

    // Restart: the localStorage-backed config persists across the reload.
    await page.reload()
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
    expect(await mixValue(page)).toBeCloseTo(engaged, 5)
  }
)

// Releasing the puck inside the centre detent snaps the mix back to exactly 0
// (off) — `enabled` derives from `mixPosition !== 0`, so float-exact zero matters.
test(
  qase(70, "Center deadzone snaps back to off"),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)
    await playFirstQueuedTrack(page)

    // First engage the mix off-centre…
    await dragMix(page, 0.8)
    await expect.poll(() => mixValue(page), { timeout: 10_000 }).toBeGreaterThan(0.15)

    // …then release inside the deadzone (x-fraction ~0.52 → |p|≈0.04): snaps to 0.
    await dragMix(page, 0.52)
    await expect.poll(() => mixValue(page), { timeout: 10_000 }).toBe(0)
  }
)
