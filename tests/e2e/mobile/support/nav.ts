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
 * A query broad enough to fill several pages under the filters the clean
 * fixture ships with (English + Bhagavad-gita + sort by reference): 809 of the
 * 5470 indexed rows match `bg*`, against 30 for a bare `1*`, which is under one
 * page and so cannot exercise paging at all.
 *
 * It stands in for what an empty box used to do. Search and the library are one
 * screen now — an empty box means the browsing landing, not the catalog — so a
 * helper that wants "a list of library tracks" has to ask for one.
 */
const BROAD_QUERY = "bg"

/**
 * The real "search the library" gesture: Search tab → type into the docked box
 * → the library lane lists what matched. Returns once at least one track row is
 * on screen.
 *
 * There is no navigation any more. The tab swaps the landing for the results in
 * place, which is also why this no longer waits out a page transition: there
 * isn't one, and the rows it finds cannot belong to a screen sliding away.
 */
export async function openLibrary(page: Page, query: string = BROAD_QUERY): Promise<void> {
  await gotoTab(page, "search")
  await searchInput(page).waitFor({ state: "visible", timeout: 20_000 })
  await searchInput(page).fill(query)
  await trackRows(page).first().waitFor({ state: "visible", timeout: 20_000 })
  await settled(page)
}

/**
 * Search tab → the "My library" shelf's chevron → the full personal-library
 * page. The shelf only renders once the store has rows, so this is the entry
 * for a library that HAS something in it; an empty one collapses to a banner
 * and the spec that cares about that taps the banner itself.
 */
export async function openMyLibrary(page: Page): Promise<void> {
  await gotoTab(page, "search")
  const chevron = page.locator(".my-library-shelf .section-more")
  await chevron.waitFor({ state: "visible", timeout: 60_000 })
  await chevron.click()
  await page.waitForURL("**/search/my-library", { timeout: 15_000 })
}

/**
 * Empty the search field and wait for the browsing landing to come back.
 *
 * The field keeps what was typed while you are on the tab, so leaving and
 * returning lands you back in the results, not on the landing. A spec that
 * wants the landing has to say so.
 */
export async function clearSearch(page: Page): Promise<void> {
  await searchInput(page).fill("")
  await expect(page.locator(".landing")).toBeVisible({ timeout: 20_000 })
}

/**
 * Wait until the list stops changing under us.
 *
 * The query is debounced and the filter binding hydrates separately, so the
 * first rows on screen can still be replaced a moment later. A caller that
 * grabbed "the first row" before that lands is holding a detached element, and
 * the failure reads as a missing child rather than a stale handle. This used to
 * be a fixed pause for the page transition; there is no transition any more,
 * but there is still a settle.
 */
async function settled(page: Page): Promise<void> {
  let previous = -1
  await expect
    .poll(
      async () => {
        const count = await trackRows(page).count()
        const stable = count > 0 && count === previous
        previous = count
        return stable
      },
      { timeout: 20_000, intervals: [250] }
    )
    .toBe(true)
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

/**
 * The library search box — the floating capsule at the bottom of the Search
 * tab, the same one the chat writes into. `.search-row` outlived the screen it
 * used to sit on, deliberately, so every spec that types into it still can; the
 * field inside is a textarea rather than an ion-input since it became shared.
 */
export function searchInput(page: Page): Locator {
  return page.locator(".search-row textarea")
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

/** The Settings → Library "Lecture languages" row that opens the picker. Matches
 *  both the English and Russian labels so it works whatever the UI language is
 *  (the content-language specs boot ru and switch the library language). */
export function libraryLanguageRow(page: Page): Locator {
  return page.locator("ion-item", { hasText: /Lecture languages|Языки лекций/ })
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

/**
 * URL the Vite dev server hands a lazily-imported UI-language chunk out at
 * (`lectorium/i18n/bundles/<locale>.ts`). `page.route` on this is how the
 * locale specs express "the chunk 404s" / "the chunk is still on the wire";
 * `en` is statically imported, which is why only non-English devices are
 * exposed to either.
 */
export function localeChunkUrl(locale: string): string {
  return `**/i18n/bundles/${locale}.ts`
}

/** The Settings → Appearance "Language of an interface" row. Matched on the
 *  subtitle so it can't collide with the chat- or library-language rows, in
 *  whichever UI language the app currently is. */
export function appLanguageRow(page: Page): Locator {
  return page.locator("ion-item", {
    hasText:
      /Language of an interface|Язык интерфейса|Мова інтерфейсу|Sprache der Oberfläche|Jezik interfejsa/,
  })
}

/**
 * The OPEN selector dialog. Settings keeps a dozen `SelectorDialog`s mounted at
 * once (interface / chat / library language, auto-archive, server, …), so the
 * only thing that identifies the one under the finger is that it is on screen.
 */
export function openSelectorDialog(page: Page): Locator {
  return page.locator("ion-modal.selector-dialog:visible")
}

/**
 * Pick a UI language through the real gesture: Settings → the interface-language
 * row → its radio → Apply. `autonym` is the native name the picker lists
 * (`Deutsch`, `Українська`, …). Does NOT wait for the switch to take effect —
 * the whole point of the locale specs is what happens in between.
 */
export async function pickAppLanguage(page: Page, autonym: string | RegExp): Promise<void> {
  await openAppLanguageDialog(page)
  const dialog = openSelectorDialog(page)
  await dialog.locator("ion-radio", { hasText: autonym }).click()
  await dialog.getByRole("button", { name: /apply|примен|застосув|anwenden/i }).click()
  await expect(dialog).toHaveCount(0, { timeout: 10_000 })
}

/**
 * The autonym the interface-language picker currently has checked — i.e. what
 * the SETTING claims, as opposed to what the UI is rendering in. Leaves the
 * dialog dismissed without committing anything.
 */
export async function checkedAppLanguage(page: Page): Promise<string> {
  await openAppLanguageDialog(page)
  const dialog = openSelectorDialog(page)
  const checked = dialog.locator("ion-radio.radio-checked")
  await expect(checked).toHaveCount(1, { timeout: 10_000 })
  const title = (await checked.innerText()).trim()
  // Escape dismisses the modal; the dialog has no Cancel, and Apply would
  // commit a pick this helper is only meant to read.
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0, { timeout: 10_000 })
  return title
}

async function openAppLanguageDialog(page: Page): Promise<void> {
  await appLanguageRow(page).first().click()
  await expect(openSelectorDialog(page).locator("ion-radio").first()).toBeVisible({
    timeout: 10_000,
  })
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
 * One touch point per on-screen transcript sentence, in document order.
 *
 * Each sentence renders as two nested elements that both carry its time
 * attributes (`$attrs` falls through to SentenceBlock's root AND is re-bound on
 * the text span), so ranges are de-duplicated. The point is the centre of the
 * element's FIRST line box — an inline span's bounding box spans the whole
 * column and covers its neighbours' text, so a point inside it can hit-test to
 * another sentence. Verse chips (`start === end`) are skipped: they carry no
 * selectable text.
 */
export async function transcriptSentencePoints(
  page: Page
): Promise<{ start: number; end: number; x: number; y: number }[]> {
  const spans = page.locator(".transcript-text [data-time-start][data-time-end]")
  await spans.first().waitFor({ state: "visible", timeout: 10_000 })
  // The transcript sits below a description + outline overview, so its first
  // sentences can start below the fold. Centre one so its neighbours on both
  // sides are on screen (a drag endpoint off screen never extends anything).
  const anchorIdx = Math.min(await spans.count(), 6) - 1
  await spans.nth(Math.max(anchorIdx, 0)).evaluate((el) => el.scrollIntoView({ block: "center" }))
  await page.waitForTimeout(300)
  return spans.evaluateAll((els) => {
    const byRange = new Map<string, { start: number; end: number; x: number; y: number }>()
    for (const el of els) {
      const start = Number(el.getAttribute("data-time-start"))
      const end = Number(el.getAttribute("data-time-end"))
      if (!(end > start)) continue
      const r = el.getClientRects()[0]
      if (!r || r.width < 60 || r.top < 0 || r.bottom > window.innerHeight) continue
      byRange.set(`${start}-${end}`, {
        start,
        end,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
      })
    }
    return [...byRange.values()].sort((a, b) => a.start - b.start)
  })
}

/**
 * Long-press and drag WITHIN a single sentence, so the selection is exactly one
 * transcript block — the shape a user gets when bookmarking one sentence, and
 * the case where a saved note used to underline its neighbours (#1731). The
 * touchMove stays inside the span's own first line box, so it re-resolves to the
 * same sentence and neither edge extends; it is still required, because
 * start→hold→release alone never opens the popover.
 *
 * Returns the selected sentence's `[start, end)` so the caller can assert the
 * underline lands on that block and no other.
 */
export async function selectOneTranscriptSentence(
  page: Page
): Promise<{ start: number; end: number }> {
  const spans = page.locator(".transcript-text [data-time-start][data-time-end]")
  await spans.first().waitFor({ state: "visible", timeout: 10_000 })
  const n = await spans.count()
  const viewport = page.viewportSize()
  const maxY = viewport ? viewport.height : Number.POSITIVE_INFINITY

  for (let i = 0; i < Math.min(n, 6); i++) {
    const span = spans.nth(i)
    const times = await span.evaluate((el) => ({
      start: Number(el.getAttribute("data-time-start")),
      end: Number(el.getAttribute("data-time-end")),
    }))
    // Verse chips carry start === end and contribute no selectable text.
    if (!(times.end > times.start)) continue

    await span.evaluate((el) => el.scrollIntoView({ block: "center" }))
    await page.waitForTimeout(200)
    // The FIRST line box, not the bounding box: an inline span's union rect
    // spans the full column width and covers its neighbours' text, so a point
    // inside it can hit-test to another sentence.
    const rect = await span.evaluate((el) => {
      const r = el.getClientRects()[0]
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    })
    if (!rect || rect.width < 60 || rect.y < 0 || rect.y + rect.height > maxY) continue

    const y = Math.round(rect.y + rect.height / 2)
    const p1 = { x: Math.round(rect.x + rect.width * 0.25), y }
    const p2 = { x: Math.round(rect.x + rect.width * 0.75), y }
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p1] })
    await page.waitForTimeout(650)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p2] })
    await page.waitForTimeout(250)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect(page.locator(".selection-actions").first()).toBeVisible({ timeout: 10_000 })
    return times
  }
  throw new Error("no on-screen transcript sentence wide enough to select")
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
