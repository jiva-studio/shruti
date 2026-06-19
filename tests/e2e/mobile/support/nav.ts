import { expect, type Locator, type Page } from "@playwright/test"

/**
 * Tap a bottom-tab button (home | search | chat | notes | settings). Ionic keeps
 * `tab`/`href` as JS properties (not reflected HTML attributes), but each button
 * carries a stable `id="tab-button-<tab>"`.
 */
export async function gotoTab(page: Page, tab: string): Promise<void> {
  await page.locator(`#tab-button-${tab}`).click()
}

/**
 * The real "open my library" gesture: Search tab → the "All lectures" button in
 * the lectures section header → the flat, filterable catalog list at
 * /tabs/search/tracks. Returns once at least one track row is on screen.
 */
export async function openLibrary(page: Page): Promise<void> {
  await gotoTab(page, "search")
  const allLectures = page.locator("ion-button.all-lectures")
  await allLectures.waitFor({ state: "visible", timeout: 20_000 })
  await allLectures.click()
  await page.waitForURL("**/tabs/search/tracks", { timeout: 10_000 })
  // Wait for the library page (its search box) and let the Ionic page transition
  // settle. The transition is a JS Web-Animation (not CSS, so our animation
  // killer doesn't touch it): until it finishes, the router outlet intercepts
  // clicks AND the discovery SearchView — which also renders `.track` rows — is
  // still on-screen, so "the first visible track" would latch onto a row that's
  // about to be hidden.
  await searchInput(page).waitFor({ state: "visible", timeout: 20_000 })
  await page.waitForTimeout(600)
  await trackRows(page).first().waitFor({ state: "visible", timeout: 20_000 })
}

/**
 * Track rows in the ACTIVE list. Ionic keeps the previous tab/page mounted but
 * hidden (the discovery SearchView also renders `.track` rows), so we scope to
 * `:visible` — otherwise `.first()` can resolve to a hidden row on a stale page.
 */
export function trackRows(page: Page): Locator {
  return page.locator("ion-item.track:visible")
}

/** Rows in the Home "Up Next" playlist (PlaylistRow wraps the same track item). */
export function playlistRows(page: Page): Locator {
  return page.locator(".playlist-row:visible")
}

/** The library search box (Android variant → <ion-input>; its native input). */
export function searchInput(page: Page): Locator {
  return page.locator(".search-row ion-input input")
}

/** Matches any Cyrillic letter. Used to tell a Russian lecture title apart from a
 *  Latin (English) one — the observable signal that a content surface is showing
 *  lectures in the chosen library language (titles follow the library language,
 *  see PR #1008). */
export const CYRILLIC = /[Ѐ-ӿ]/

/** Trimmed titles of the track rows on the ACTIVE list (scoped to `:visible`). */
export async function trackTitles(page: Page): Promise<string[]> {
  return (await trackRows(page).locator(".title").allInnerTexts()).map((t) => t.trim())
}

/** The Settings → Library "Lecture languages" row that opens the picker. */
export function libraryLanguageRow(page: Page): Locator {
  return page.locator("ion-item", { hasText: "Lecture languages" })
}

/**
 * The open library-language picker. Several `SelectorDialog`s sit in the DOM at
 * once (interface / chat / library); only the library one is a multi-select, so
 * "the selector dialog that contains checkboxes" uniquely identifies it.
 */
export function libraryLanguageDialog(page: Page): Locator {
  return page.locator("ion-modal.selector-dialog", { has: page.locator("ion-checkbox") })
}

/**
 * Edit the library-language set via Settings → Library (the multi-select
 * checkbox dialog). `add`/`remove` match a checkbox by its label text. Leaves
 * the app on the Settings tab. Shared by the content-language specs (topic,
 * collection) that flip the library language while the UI language stays put.
 */
export async function editLibraryLanguages(
  page: Page,
  opts: { add?: string | RegExp; remove?: string | RegExp }
): Promise<void> {
  await gotoTab(page, "settings")
  await libraryLanguageRow(page).click()
  const dialog = libraryLanguageDialog(page)
  await expect(dialog.locator("ion-checkbox").first()).toBeVisible({ timeout: 10_000 })
  if (opts.add) await dialog.locator("ion-checkbox", { hasText: opts.add }).click()
  if (opts.remove) await dialog.locator("ion-checkbox", { hasText: opts.remove }).click()
  await dialog.getByRole("button", { name: /apply|примен/i }).click()
}

/** The per-track detail bottom sheet (TrackSheet). */
export function trackSheet(page: Page): Locator {
  return page.locator("ion-modal.track-sheet")
}

/** Open the detail sheet for a given track row and wait for it to present. */
export async function openTrackSheet(page: Page, row: Locator): Promise<void> {
  await row.click()
  const sheet = trackSheet(page)
  await expect(sheet).toBeVisible()
  await expect(sheet.locator(".sheet-actions")).toBeVisible()
}

/**
 * Tap the first track in the Home "Up Next" queue to start it and wait until the
 * player leaves its `hidden` state — the observable signal that the engine
 * loaded the (stubbed) audio and "now playing" is live.
 */
export async function playFirstQueuedTrack(page: Page): Promise<void> {
  const firstTrack = playlistRows(page).first().locator("ion-item.track")
  await firstTrack.waitFor({ state: "visible", timeout: 20_000 })
  await firstTrack.click()
  await expect(page.locator(".player")).not.toHaveClass(/\bhidden\b/, { timeout: 20_000 })
}

/**
 * Swipe a playlist row open and tap its delete (danger) option. The row is an
 * Ionic `ion-item-sliding`; the swipe is a JS gesture we can't reliably drag in
 * Playwright, so we call the component's own `open("end")` then click the
 * revealed `ion-item-option[color="danger"]`.
 */
export async function deletePlaylistRow(page: Page, row: Locator): Promise<void> {
  const sliding = row.locator("ion-item-sliding")
  await sliding.evaluate((el: HTMLElement & { open(side?: string): Promise<void> }) => el.open("end"))
  await row.locator('ion-item-option[color="danger"]').click()
}

/** A settings-page toggle, found by its (English) label text. */
export function settingToggle(page: Page, label: string): Locator {
  return page.locator("ion-item", { hasText: label }).locator("ion-toggle")
}

/** Play the first queued track, then tap the player to open the transcript reader. */
export async function openTranscript(page: Page): Promise<void> {
  await playFirstQueuedTrack(page)
  await page.locator(".player").click()
  const dialog = page.locator("ion-modal.transcript-dialog")
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await expect(dialog.locator(".transcript-text")).toBeVisible({ timeout: 20_000 })
}

/**
 * Long-press drag-select across two transcript sentences via CDP touch, then wait
 * for the selection popover. The touchMove is essential — start→hold→release
 * alone never opens it.
 */
export async function selectTranscriptText(page: Page): Promise<void> {
  const spans = page.locator(".transcript-text [data-time-start][data-time-end]")
  await spans.first().waitFor({ state: "visible", timeout: 10_000 })
  const n = await spans.count()

  // The transcript can sit below a description + lecture-outline overview, so the
  // first sentence may render near the bottom edge with the later sentences off-
  // screen — a drag whose endpoint is off-screen never extends the selection.
  // Center the first sentence so the next few are on-screen too.
  await spans.first().evaluate((el) => el.scrollIntoView({ block: "center" }))
  await page.waitForTimeout(200)

  const viewport = page.viewportSize()
  const maxY = viewport ? viewport.height : Number.POSITIVE_INFINITY
  const b1 = await spans.nth(0).boundingBox()
  if (!b1) throw new Error("no transcript sentence spans found")
  // Drag to the furthest of the next sentences whose box is fully on-screen, so
  // the touchMove endpoint is always a real, hittable point (and the selection
  // still spans more than one sentence).
  let b2 = b1
  for (let i = Math.min(2, n - 1); i >= 1; i--) {
    const b = await spans.nth(i).boundingBox()
    if (b && b.y >= b1.y && b.y + b.height <= maxY) {
      b2 = b
      break
    }
  }
  if (b2 === b1) throw new Error("no second on-screen transcript sentence to drag to")
  const p1 = { x: Math.round(b1.x + b1.width / 2), y: Math.round(b1.y + b1.height / 2) }
  const p2 = { x: Math.round(b2.x + b2.width / 2), y: Math.round(b2.y + b2.height / 2) }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p1] })
  await page.waitForTimeout(650)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p2] })
  await page.waitForTimeout(250)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await expect(page.locator(".selection-actions").first()).toBeVisible({ timeout: 10_000 })
}

/** Buttons in the transcript selection popover, in order: copy · bookmark · share · ask. */
export function selectionAction(page: Page, which: "copy" | "bookmark" | "share" | "ask"): Locator {
  const index = { copy: 0, bookmark: 1, share: 2, ask: 3 }[which]
  return page.locator(".selection-actions ion-button").nth(index)
}

/**
 * Swipe the floating player's carousel up until `selector` is on screen, so a
 * value-only spec (speed / stereo-mix — driven via synthetic events on the
 * off-screen control) can SCREENSHOT the actual control. Best-effort and for
 * screenshots only: it never throws and never fails the test, so the assertion
 * stays on the deterministic stored value.
 */
export async function revealPlayerPanel(page: Page, selector: string, maxSwipes = 4): Promise<void> {
  try {
    const player = page.locator(".player")
    const target = page.locator(selector).first()
    // The carousel is vertical (translateY): mix is page 0 (above the default
    // now-playing page), speed is page 2 (below). Swipe TOWARD the target — up to
    // bring a below-viewport page in, down for an above-viewport page.
    const probe = () =>
      target
        .evaluate((el) => {
          const r = (el as HTMLElement).getBoundingClientRect()
          return { top: r.top, bottom: r.bottom, h: r.height, vh: window.innerHeight }
        })
        .catch(() => null)

    const cdp = await page.context().newCDPSession(page)
    for (let i = 0; i < maxSwipes; i++) {
      const r = await probe()
      if (!r) return
      if (r.h > 0 && r.top >= 0 && r.bottom <= r.vh) return // already on screen
      const box = await player.boundingBox()
      if (!box) return
      const cx = Math.round(box.x + box.width / 2)
      const down = r.top < 0 // target sits above the viewport → move the track down
      const yStart = Math.round(down ? box.y + box.height * 0.25 : box.y + box.height * 0.8)
      const yEnd = Math.round(down ? box.y + box.height * 1.5 : box.y - box.height * 0.6)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: yStart }] })
      for (const f of [0.25, 0.5, 0.75, 1]) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: cx, y: Math.round(yStart + (yEnd - yStart) * f) }],
        })
        await page.waitForTimeout(40)
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      await page.waitForTimeout(350)
    }
  } catch {
    /* best-effort: the screenshot just stays on the current frame */
  }
}
