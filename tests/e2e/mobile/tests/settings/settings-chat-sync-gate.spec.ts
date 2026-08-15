import type { Page } from "@playwright/test"
import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedDismissedNags,
  preseedNonPro,
  preseedOnboardingDone,
  preseedSearchFilter,
  preseedUserDbOnce,
} from "../../support/bootstrap.js"
import { gotoTab, settingToggle } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Issue #1848 — "Sync chats" off used to gate the upload only, so a device with
 * the toggle off still received every conversation started on another one.
 *
 * The user DB is seeded ONCE (not on every navigation), so the pull cursor a
 * skipped page leaves behind survives the relaunch — which is what makes the
 * gap watermark load-bearing rather than incidental.
 */

/** A conversation the user started on their tablet, as the server's change log
 *  would offer it: the session first, then its one message. */
const REMOTE_TITLE = "Started on the tablet"
const REMOTE_LOG = [
  {
    server_seq: 1,
    collection: "chat_sessions",
    doc_id: "sess-tablet",
    op: "upsert" as const,
    hlc: "001800000000001:00001:dev-e2e-tablet",
    data: {
      id: "sess-tablet",
      title: REMOTE_TITLE,
      created_at: 1_800_000_000_000,
      updated_at: 1_800_000_000_000,
      track_id: null,
    },
  },
  {
    server_seq: 2,
    collection: "chat_messages",
    doc_id: "msg-tablet",
    op: "upsert" as const,
    hlc: "001800000000002:00001:dev-e2e-tablet",
    data: {
      id: "msg-tablet",
      session_id: "sess-tablet",
      role: "user",
      content: "What is the soul?",
      created_at: 1_800_000_000_000,
      meta: null,
    },
  },
]

async function relaunch(page: Page): Promise<void> {
  await page.reload()
  await page.waitForURL("**/tabs/**", { timeout: 60_000 })
  await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
}

/** Flip a settings toggle by its visible title and wait for the new state. */
async function setToggle(page: Page, title: string, on: boolean): Promise<void> {
  const toggle = settingToggle(page, title)
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  const want = on ? "true" : "false"
  if ((await toggle.getAttribute("aria-checked")) !== want) await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", want, { timeout: 10_000 })
}

/** The chat-history sheet's session rows. */
function historyRows(page: Page) {
  return page.locator("ion-modal:not(.overlay-hidden)").locator("ion-item-sliding")
}

async function openHistory(page: Page): Promise<void> {
  await gotoTab(page, "chat")
  await page.locator('.chat-page .action-btn[aria-label="Chat history"]').click()
  await expect(page.locator("ion-modal:not(.overlay-hidden)")).toBeVisible({ timeout: 10_000 })
}

async function closeHistory(page: Page): Promise<void> {
  await page.keyboard.press("Escape")
  await expect(page.locator("ion-modal:not(.overlay-hidden)")).toBeHidden({ timeout: 10_000 })
}

test(qase(352, caseTitle(352)), { tag: ["@offline", "@settings", "@chat"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedOnboardingDone(page)
  await preseedUserDbOnce(page, "en", "clean")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)
  await preseedNonPro(page)

  // The `profile` change log, served from whatever cursor the client asks for.
  // It starts empty so the boot cycle has nothing to race the toggle with.
  let log: typeof REMOTE_LOG = []
  let pulls = 0
  await page.route("**/profile/sync/pull", (route) => {
    const body = route.request().postData()
    const from = body ? ((JSON.parse(body) as { cursor?: number }).cursor ?? 0) : 0
    pulls++
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        changes: log.filter((c) => c.server_seq > from),
        cursor: log.length,
        has_more: false,
      }),
    })
  })

  await page.goto("/?locale=en")
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })

  await step(page, 352, 0, async () => {
    // Turn "Sync chats" off, then put a conversation from another device on the
    // server and relaunch so a full cycle runs with the toggle off.
    await gotoTab(page, "settings")
    await setToggle(page, "Sync chats", false)
    log = REMOTE_LOG
    const before = pulls
    await relaunch(page)
    await expect.poll(() => pulls, { timeout: 30_000 }).toBeGreaterThan(before)
  })

  await step(page, 352, 1, async () => {
    // The conversation is NOT on this device: off means chat does not sync in
    // either direction.
    await openHistory(page)
    await expect(page.getByText(REMOTE_TITLE)).toHaveCount(0)
    await expect(historyRows(page)).toHaveCount(0)
    await closeHistory(page)
  })

  await step(page, 352, 2, async () => {
    // Turning it back on rewinds the pull cursor to where the skipping began,
    // so the conversation the device passed over arrives after all.
    await gotoTab(page, "settings")
    await setToggle(page, "Sync chats", true)
    await expect
      .poll(
        async () => {
          await openHistory(page)
          const found = await page.getByText(REMOTE_TITLE).count()
          await closeHistory(page)
          return found
        },
        { timeout: 60_000 }
      )
      .toBeGreaterThan(0)
  })
})
