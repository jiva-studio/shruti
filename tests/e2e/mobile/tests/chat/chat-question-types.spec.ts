import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"
import { mockChatAuth, mockChatStream, askChat, delta, action, done } from "../../support/chat-mock.js"

// What these verify is the rendered WIDGET, not the answer prose. Each chat
// request type is driven entirely by a mocked SSE stream: an `action` side-event
// ships the card body, then a prose `delta` carries the inline marker that
// references it by key. No backend — so each request type renders its
// characteristic card deterministically, and we assert the CARD, not the text.
// (Wire shapes verified against infra/chat/http/chatClient.ts validators.)
// Titles + steps come from the qase/cases.json registry.

const VERSE = action({
  kind: "verse",
  id: "v1",
  payload: {
    source_id: "source_x",
    tokens: "2.13",
    addr_label: "BG 2.13",
    sanskrit: "dehino 'smin yathā dehe",
    transliteration: "dehino 'smin yathā dehe",
    translation: { en: "As the embodied soul continuously passes…" },
  },
})

const CHAPTER = action({
  kind: "chapter",
  id: "ch1",
  payload: {
    source_id: "source_bg",
    region_token: "ch3",
    region_label: "Chapter 3: Karma-linux-client",
    chapters: [
      { tokens: "3.1", title: "Arjuna's question on action" },
      { tokens: "3.2", title: "The path of selfless work" },
    ],
  },
})

const sharePdf = (id: string, title: string, track: string) =>
  action({
    kind: "share_pdf",
    id,
    payload: {
      items: [
        { track_id: track, transcript_key: `transcripts/${track}.txt`, title, lang: "en", references: [], tags: [] },
      ],
    },
  })

// show_verse: a bare scripture reference renders a verse card carrying the address.
test(qase(85, caseTitle(85)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(page, [VERSE, delta("Krishna explains:\n\n[verse:source_x/2.13|BG 2.13]\n\nEternal."), done()])
  await boot(page)
  await gotoTab(page, "chat")
  await step(page, 85, 0, async () => {
    await askChat(page, "BG 2.13")
    const verse = page.locator(".verse-card-addr, .scripture-chip")
    await expect(verse.first()).toBeVisible({ timeout: 20_000 })
    await expect(verse.first()).toContainText("2.13")
  })
})

// locate intent: a "which chapter" question renders the chapter list card.
test(qase(87, caseTitle(87)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(page, [CHAPTER, delta("That story is here:\n\n[chapter:source_bg/ch3|Chapter 3]"), done()])
  await boot(page)
  await gotoTab(page, "chat")
  await step(page, 87, 0, async () => {
    await askChat(page, "Which chapter is about karma-linux-client?")
    await expect(page.locator(".chapter-card-list").first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(".chapter-card-item").first()).toContainText(/karma|action|work/i)
  })
})

// chapter WIDGET: the same chapter marker upgrades into a multi-row list.
test(qase(91, caseTitle(91)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(page, [CHAPTER, delta("That story is here:\n\n[chapter:source_bg/ch3|Chapter 3]"), done()])
  await boot(page)
  await gotoTab(page, "chat")
  await step(page, 91, 0, async () => {
    await askChat(page, "Which chapter is about karma-linux-client?")
    await expect(page.locator(".chapter-card-list").first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(".chapter-card-item")).toHaveCount(2)
  })
})

// create_action (pdf) intent: a "make a PDF" request renders the share-PDF card.
test(qase(86, caseTitle(86)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(page, [
    sharePdf("pdf12345", "The Eternal Soul", "track_x"),
    delta("Here is the lecture as a PDF:\n\n[action:share_pdf|id=pdf12345]"),
    done(),
  ])
  await boot(page)
  await gotoTab(page, "chat")
  await step(page, 86, 0, async () => {
    await askChat(page, "Make a PDF of this lecture")
    await expect(page.locator(".pdf-list").first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(".pdf-title").first()).toContainText("Eternal Soul")
  })
})

// share-PDF WIDGET: each listed lecture is a tappable export row.
test(qase(92, caseTitle(92)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(page, [
    sharePdf("pdf67890", "On Detachment", "track_y"),
    delta("Download it here:\n\n[action:share_pdf|id=pdf67890]"),
    done(),
  ])
  await boot(page)
  await gotoTab(page, "chat")
  await step(page, 92, 0, async () => {
    await askChat(page, "Share this as a PDF")
    const row = page.locator(".pdf-row").first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText("Detachment")
    await expect(row).toBeEnabled()
  })
})
