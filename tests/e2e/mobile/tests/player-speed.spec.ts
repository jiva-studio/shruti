import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { playFirstQueuedTrack } from "../support/nav.js"

// The playback-speed slider snaps to presets (0.75…2.0). It lives on the
// floating player's carousel (page 3 of 3), drag-only by its puck. We drive it
// with synthetic pointer events anchored to the slider track's x-rect — which
// is all `applyFromClientX` reads — so we don't need to reveal the carousel
// page. On release the value commits to the nearest preset and persists to the
// audio config; we assert that persisted value.
test(
  qase(56, "Change playback speed with snap to presets"),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)
    await playFirstQueuedTrack(page)

    const slider = page.locator(".speed-skip-panel .speed-slider")
    const trackEl = slider.locator(".track")
    const puck = slider.locator(".puck")
    await expect(puck).toHaveCount(1)

    // Target 1.5× → fraction (1.5-0.75)/(2-0.75) = 0.6 along the inner rail.
    const PUCK_HALF = 10
    const box = await trackEl.boundingBox()
    if (!box) throw new Error("speed slider track has no box")
    const startX = box.x + PUCK_HALF
    const targetX = box.x + PUCK_HALF + 0.6 * (box.width - PUCK_HALF * 2)
    const y = box.y + box.height / 2

    await puck.evaluate(
      (el, { sx, ty, yy }) => {
        // A synthetic pointer can't engage real pointer capture; neutralise it
        // so the drag-pump's pointerdown handler doesn't throw.
        const proto = Element.prototype as unknown as { setPointerCapture: (id: number) => void }
        const orig = proto.setPointerCapture
        proto.setPointerCapture = () => {}
        const opts = (x: number) => ({ pointerId: 1, clientX: x, clientY: yy, bubbles: true })
        el.dispatchEvent(new PointerEvent("pointerdown", opts(sx)))
        window.dispatchEvent(new PointerEvent("pointermove", opts(ty)))
        window.dispatchEvent(new PointerEvent("pointerup", opts(ty)))
        proto.setPointerCapture = orig
      },
      { sx: startX, ty: targetX, yy: y }
    )

    // The commit persisted the snapped preset (1.5×) to the audio config.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Number(localStorage.getItem("CapacitorStorage.settings.audio.playbackSpeed"))
          ),
        { timeout: 10_000 }
      )
      .toBe(1.5)
  }
)
