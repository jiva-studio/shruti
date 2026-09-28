import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { clearSearch, gotoTab, searchInput, trackRows, trackTitles } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Type `query`, wait for the list to hold still, and hand back what it shows.
 *
 * Empties the field first: the two spellings compared here differ by one
 * codepoint, so typing the second over the first lands inside the debounce
 * window of the first and what settles is whichever query won the gate. The
 * landing in between makes each spelling its own query.
 */
async function search(page: import("@playwright/test").Page, query: string): Promise<string[]> {
  await clearSearch(page)
  await searchInput(page).fill(query)
  await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
  let previous = ""
  await expect
    .poll(
      async () => {
        const now = (await trackTitles(page)).join("|")
        const stable = now.length > 0 && now === previous
        previous = now
        return stable
      },
      { timeout: 20_000, intervals: [250] }
    )
    .toBe(true)
  return trackTitles(page)
}

// A combining mark is part of the word, not a space. The index folds it away
// and keeps the word whole, so an accented spelling has to reach the same
// lectures as the plain one — splitting on marks would send `кри* шна*`, which
// are ANDed and meet nothing.
test(qase(168, caseTitle(168)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "ru", { userDb: "clean" })
  await gotoTab(page, "search")
  await searchInput(page).waitFor({ state: "visible", timeout: 20_000 })

  await step(page, 168, 0, async () => {
    const plain = await search(page, "Кришна")
    expect(plain.length).toBeGreaterThan(0)
    // U+0301 on the и — the stress mark a dictionary spelling carries.
    const accented = await search(page, "Кри́шна")
    expect(accented).toEqual(plain)
  })

  await step(page, 168, 1, async () => {
    // Read this for what it is: a guard against the query builder deleting
    // `ī`/`ā` outright and sending `bhagavadgt*`. It is not coverage of mark
    // folding — `remove_diacritics=2` strips those marks out of the MATCH term
    // too, so both spellings resolve to the same query either way. The pair in
    // the next case is the one SQLite does not fold on its own.
    const iast = await search(page, "Bhagavad-gītā")
    expect(iast.length).toBeGreaterThan(0)
    const ascii = await search(page, "Bhagavad-gita")
    expect(ascii).toEqual(iast)
  })
})

// `ё`. SQLite keeps it as a term of its own, so unlike the Latin
// marks above nothing folds it for us — shruti-mcp folds the index
// (`008_fold_fts_marks`) and the query builder folds to match.
//
// The corpus spells this particular word both ways ("Душа остаётся загадкой
// для нас" and "Душа всегда остается личностью"), which is what makes the
// assertion sharp: one query has to reach both. Against an unfolded index it
// reaches only the `е`-spelled title, however the user types it — so a bare
// "the two spellings agree" comparison would pass while half the corpus stayed
// unreachable. Hence the assertion that both spellings are listed.
test(qase(200, caseTitle(200)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "ru", { userDb: "clean" })
  await gotoTab(page, "search")
  await searchInput(page).waitFor({ state: "visible", timeout: 20_000 })

  let accented: string[] = []
  await step(page, 200, 0, async () => {
    accented = await search(page, "остаётся")
    expect(accented.some((title) => title.includes("остаётся"))).toBe(true)
    expect(accented.some((title) => title.includes("остается"))).toBe(true)
  })

  await step(page, 200, 1, async () => {
    // The spelling a Russian keyboard produces.
    const plain = await search(page, "остается")
    expect(plain).toEqual(accented)
  })
})
