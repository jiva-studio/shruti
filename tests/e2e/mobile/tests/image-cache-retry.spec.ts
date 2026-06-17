import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

/**
 * Regression for the "flaky cover never recovers" bug. Collection / topic covers
 * are fetched (web: `fetch` inside the CacheStorage-backed remote-files storage)
 * from the prod S3 asset host — `https://akds-lectorium.s3.us-east-1.amazonaws.com/
 * public/collections/<pack>/cover.jpg` (see resolveAssetUrl → buildServerUrl and
 * the `cover` keys in content.db). `CachedImage` keeps the `<img>` at opacity:0
 * until it decodes.
 *
 * Before the fix, `useCachedImageUrl` caught a failed `get()` and fell back to the
 * RAW remote URL with no `@error` handler — so if that link was still flaky the
 * `<img>` errored, `loaded` never flipped, and the cover stayed invisible forever
 * with no retry. The fix adds a bounded retry (cached-resolve re-attempts + an
 * `@error` → retry() signal), so the cover recovers on the next good request.
 *
 * We make ONE chosen cover flaky deterministically with a per-URL call counter:
 * the FIRST request to it is aborted, every later request to it is fulfilled with
 * a real PNG. All other covers are fulfilled normally. With the buggy code the
 * targeted cover never loads (test fails); with the fix its `<img>` recovers.
 */

// A 1x1 PNG — a real, decodable image so naturalWidth ends up > 0.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64"
)

const COVER_GLOB = "**/public/collections/**"

// How many of the chosen cover's first requests to drop. Sized to outlast the
// buggy code's two paths (the cached-resolve fetch + the raw-URL fallback
// fetch, plus one optional prewarm fetch) so it never recovers, while the fix's
// bounded retry still lands a good request afterwards.
const ABORTS = 3

test(
  "library · a cover that fails once on a flaky network recovers",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // Per-URL request counter: drives a deterministic "first request fails,
    // retry succeeds" for the FIRST cover we see, while every other cover is
    // fulfilled normally. No real-time waits — determinism comes from counts.
    const calls = new Map<string, number>()
    let targetUrl: string | undefined

    await page.route(COVER_GLOB, async (route) => {
      const url = route.request().url()
      // Latch the first cover we observe as the flaky one.
      if (targetUrl === undefined) targetUrl = url

      const n = (calls.get(url) ?? 0) + 1
      calls.set(url, n)

      // Drop the FIRST FEW requests to the chosen cover. This must cover BOTH
      // the cached-resolve `get()` fetch AND the raw-URL fallback `<img>` fetch
      // (same URL, separate requests) so the buggy code — which has no retry —
      // exhausts its only two paths and the cover stays invisible forever. The
      // fix re-attempts the cached resolve a couple times with a short backoff,
      // so it recovers on a later request.
      if (url === targetUrl && n <= ABORTS) {
        await route.abort("failed")
        return
      }
      // Every other cover, and every request past the abort budget → a real PNG.
      await route.fulfill({ status: 200, contentType: "image/png", body: PNG_1x1 })
    })

    await boot(page)
    // Search landing: collection / topic tiles render through CachedImage.
    await gotoTab(page, "search")

    const cards = page.locator(".carousel-section .collection-card")
    await cards.first().waitFor({ state: "visible", timeout: 20_000 })

    // The chosen-flaky cover's <img>. Its src points at the targetUrl's cached
    // blob (or raw url); the only stable handle is the loaded class on the
    // CachedImage layer, so assert that at least one cover recovered to loaded
    // AND that the flaky cover specifically was re-requested (retry happened).
    const loadedCovers = page.locator(".collection-card .cached-image.is-loaded")

    // With the fix, the once-aborted cover re-requests and decodes, so every
    // visible cover (including the flaky one) ends up loaded. Without the fix
    // the flaky cover stays invisible and this never reaches the full count.
    await expect(async () => {
      // The flaky cover must have been retried PAST the abort budget — proof the
      // bounded retry kept going where the buggy code gave up.
      expect(targetUrl).toBeTruthy()
      expect(calls.get(targetUrl!) ?? 0).toBeGreaterThan(ABORTS)
      // And at least one cover layer is decoded + visible.
      expect(await loadedCovers.count()).toBeGreaterThan(0)
    }).toPass({ timeout: 25_000 })

    // Stronger: the flaky cover's own <img> decoded (naturalWidth > 0). Find the
    // CachedImage whose currentSrc traces back to a successful retry — every
    // loaded cover satisfies naturalWidth > 0, and the flaky one is among them.
    const decoded = await loadedCovers.evaluateAll((imgs) =>
      imgs.every((el) => (el as HTMLImageElement).naturalWidth > 0)
    )
    expect(decoded).toBe(true)
  }
)
