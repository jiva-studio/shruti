import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { playFirstQueuedTrack } from "../../support/nav.js"

const activeDot = () => `(() => { const d = [...document.querySelectorAll(".page-dots .dot")]; return d.findIndex(x => x.classList.contains("active")); })()`

test(
  qase(146, "Swiping the floating player changes its page"),
  { tag: ["@offline", "@player"] },
  async ({ page }) => {
    await boot(page)
    await playFirstQueuedTrack(page)

    const player = page.locator(".player")
    await expect(player).toBeVisible()
    const before = await page.evaluate(activeDot())

    // CDP vertical swipe (up) inside the player → the carousel advances a page.
    const box = await player.boundingBox()
    if (!box) throw new Error("no player box")
    const cx = Math.round(box.x + box.width / 2)
    const yLow = Math.round(box.y + box.height * 0.8)
    const yHigh = Math.round(box.y - box.height * 0.6) // drag well past the top
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: yLow }] })
    for (const y of [yLow - 20, yLow - 50, (yLow + yHigh) / 2, yHigh]) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx, y: Math.round(y) }] })
      await page.waitForTimeout(40)
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })

    await expect
      .poll(async () => page.evaluate(activeDot()), { timeout: 10_000 })
      .not.toBe(before)
  }
)
