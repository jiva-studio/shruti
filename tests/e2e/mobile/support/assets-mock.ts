import fs from "fs"
import type { Page } from "@playwright/test"
import { COVER_PNG_PATH } from "./fixtures.js"

/**
 * Cover art for the catalog rows.
 *
 * `content.db` stores covers as `public/collections/<pack>/cover.jpg` and
 * `public/topics/<topic>/cover.jpg`, which resolve against the sink region and
 * die with ERR_CONNECTION_REFUSED — a single library spec fires a hundred of
 * them. That noise is not the real cost: with nothing served, every tile falls
 * back to its no-cover tint, so a spec that means to assert on cover art passes
 * whether or not the plumbing works.
 *
 * Serving the fixture PNG makes the fallback a deliberate signal again — a tile
 * showing the tint now means the app chose not to ask for a cover, which is
 * what `image-cache-retry` deliberately re-breaks by overriding this route.
 */
export async function interceptCovers(page: Page): Promise<void> {
  const png = fs.readFileSync(COVER_PNG_PATH)
  const serve = (route: import("@playwright/test").Route): void => {
    void route.fulfill({ status: 200, contentType: "image/png", body: png })
  }
  await page.route("**/public/collections/**", serve)
  await page.route("**/public/topics/**", serve)
}
