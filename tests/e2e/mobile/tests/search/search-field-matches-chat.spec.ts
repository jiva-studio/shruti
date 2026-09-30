import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import type { Page } from "@playwright/test"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, searchInput } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * The library search field and the chat composer are one capsule in one dock,
 * so switching tabs must not move it, and the keyboard must lift both alike.
 *
 * The keyboard is simulated the way a device presents it to the page: Capacitor
 * fires `keyboardWillShow` on the window, Ionic hides the tab bar on it, and the
 * WebView shrinks by the keyboard's height.
 */

const KEYBOARD_HEIGHT = 300
const DOCK_GAP = 8

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function capsuleBox(page: Page, dock: string): Promise<Box> {
  const capsule = page.locator(`${dock} .floating-input`)
  await expect(capsule).toBeVisible()
  const box = await capsule.boundingBox()
  if (!box) throw new Error(`no box for ${dock}`)
  return box
}

async function showKeyboard(page: Page): Promise<void> {
  const size = page.viewportSize()
  if (!size) throw new Error("no viewport")
  await page.evaluate(() => window.dispatchEvent(new Event("keyboardWillShow")))
  await page.setViewportSize({ width: size.width, height: size.height - KEYBOARD_HEIGHT })
  await expect(page.locator("ion-tab-bar")).toBeHidden()
}

async function hideKeyboard(page: Page): Promise<void> {
  const size = page.viewportSize()
  if (!size) throw new Error("no viewport")
  await page.setViewportSize({ width: size.width, height: size.height + KEYBOARD_HEIGHT })
  await page.evaluate(() => window.dispatchEvent(new Event("keyboardWillHide")))
  await expect(page.locator("ion-tab-bar")).toBeVisible()
}

test(qase(608, caseTitle(608)), { tag: ["@offline", "@search", "@chat"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })

  await step(page, 608, 0, async () => {
    await gotoTab(page, "chat")
    const chat = await capsuleBox(page, ".chat-inputbar")
    await gotoTab(page, "search")
    await searchInput(page).waitFor({ state: "visible", timeout: 20_000 })
    const search = await capsuleBox(page, ".search-bar")
    expect(search).toEqual(chat)
  })

  await step(page, 608, 1, async () => {
    await showKeyboard(page)
    const search = await capsuleBox(page, ".search-bar")
    await hideKeyboard(page)

    await gotoTab(page, "chat")
    await showKeyboard(page)
    const chat = await capsuleBox(page, ".chat-inputbar")
    const viewport = page.viewportSize()
    await hideKeyboard(page)

    expect(search).toEqual(chat)
    expect(viewport?.height).toBe(chat.y + chat.height + DOCK_GAP)
  })
})
