import { readFileSync } from "fs"
import { test, type Page } from "@playwright/test"
import { qase } from "playwright-qase-reporter"

/**
 * Steps come from the JSON registry (qase/cases.json) — the single source of
 * truth. The same file is synced INTO Qase by qase/sync.mjs, so a step's text
 * lives in exactly one place: edit cases.json, re-sync, done.
 *
 * A spec references its case by Qase id:
 *
 *   test(qase(89, caseTitle(89)), …, async ({ page }) => {
 *     await step(page, 89, 0, async () => { … })   // step 0 of case 89
 *     await step(page, 89, 1, async () => { … })   // step 1
 *   })
 *
 * `step()` pulls the action + expected text from the registry, runs the body,
 * and (when QASE_MODE=testops) attaches an end-of-step screenshot — so each step
 * in the run carries pass/fail + a PNG, all driven by the registry.
 */

interface RegStep {
  action: string
  expected: string
}
interface RegCase {
  title: string
  steps: RegStep[]
}

const registry: Record<string, RegCase> = JSON.parse(
  readFileSync(new URL("../qase/cases.json", import.meta.url), "utf8")
)

/** The registry title for a case — use as the `qase(id, …)` name so the run title
 * matches the case. */
export function caseTitle(id: number): string {
  const c = registry[String(id)]
  if (!c) throw new Error(`qase registry: no case ${id} in cases.json`)
  return c.title
}

const PUBLISHING = process.env.QASE_MODE === "testops"

function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "step"
}

/** Attach a full-page screenshot of the current state to the active Qase step.
 * No-op unless publishing to Qase.
 *
 * The capture is taken AFTER the step asserted its expected state, but Ionic
 * page/modal transitions and fade-ins can still be mid-flight — a naive
 * screenshot then catches a half-rendered frame. We let the transition settle
 * (longer than a typical Ionic page/modal transition) so the captured frame is
 * the finished UI. We deliberately do NOT use Playwright's
 * `animations: "disabled"`: it fast-forwards Web-Animations-driven Ionic
 * transitions, which can complete a modal dismiss early and break a step that
 * interacts with that modal afterwards (e.g. the filters-sheet Reset flow). */
export async function shot(page: Page, name: string): Promise<void> {
  if (!PUBLISHING) return
  await page.waitForTimeout(350)
  const png = await page.screenshot()
  qase.attach({ name: `${slug(name)}.png`, content: png, contentType: "image/png" })
}

/**
 * Run step `index` of case `caseId`: its action + expected come from the
 * registry, `body` performs it, and a screenshot is captured at the end.
 */
export async function step<T>(
  page: Page,
  caseId: number,
  index: number,
  body: () => Promise<T>
): Promise<T> {
  const c = registry[String(caseId)]
  if (!c) throw new Error(`qase registry: no case ${caseId} in cases.json`)
  const s = c.steps[index]
  if (!s) throw new Error(`qase registry: case ${caseId} has no step #${index}`)
  return test.step(qase.step(s.action, s.expected), async () => {
    const result = await body()
    await shot(page, s.action)
    return result
  })
}
