import { type Page } from "@playwright/test"
import { requireFixtures } from "./test.js"
import { preseedOnboardingDone } from "./bootstrap.js"
import { sendButton } from "./chat-mock.js"

/**
 * Boot for @live tests. Unlike the offline `boot()`, this intercepts NOTHING:
 * the app is served with VITE_DEV_REGION=true (the `stack` project in
 * playwright.config.ts, enabled by E2E_INCLUDE_LIVE=1), which points chat + auth
 * at the local stack (localhost:11080 / :11081) while the catalog/content still
 * come from the prod CDN. The local auth service mints an anonymous token on
 * first load, so chat is usable without any mock.
 *
 * The waits are far longer than the offline `boot()`'s: nothing is served from
 * `fixtures/` here, so first paint waits on the real catalog DB coming down the
 * CDN. At the offline budget the tab-bar wait fails on a slow link while the app
 * is booting perfectly well.
 *
 * Prereq: the stack is up (`scripts/live-up.sh`, chat `/readyz` green). See README.
 */
export async function bootLive(page: Page, locale: "en" | "ru" = "en"): Promise<void> {
  requireFixtures()
  await preseedOnboardingDone(page)
  await page.goto(`/?locale=${locale}`)
  await page.waitForURL("**/tabs/home", { timeout: 120_000 })
  await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 60_000 })
}

/** Open the chat tab, type a query and send it. */
export async function askChat(page: Page, text: string): Promise<void> {
  await page.locator("#tab-button-chat").click()
  const input = page.locator(".chat-inputbar textarea")
  await input.waitFor({ state: "visible", timeout: 20_000 })
  await input.fill(text)
  await sendButton(page).click()
}

/** The latest assistant bubble. */
export function assistantBubble(page: Page) {
  return page.locator(".bubble.assistant, .bubble-row.assistant").last()
}
