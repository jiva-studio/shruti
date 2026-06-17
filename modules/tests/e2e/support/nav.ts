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
  await spans.first().scrollIntoViewIfNeeded()
  const n = await spans.count()
  const b1 = await spans.nth(0).boundingBox()
  const b2 = await spans.nth(Math.min(2, n - 1)).boundingBox()
  if (!b1 || !b2) throw new Error("no transcript sentence spans found")
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
