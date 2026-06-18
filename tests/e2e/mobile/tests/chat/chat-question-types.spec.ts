import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { mockChatAuth, mockChatStream, askChat, delta, action, done } from "../../support/chat-mock.js"

// The chat answer's rich cards are driven entirely by the SSE stream: an
// `action` side-event ships the card body, then a prose `delta` carries the
// inline marker that references it by key. No backend — the stream is mocked,
// so each request-type renders its characteristic card deterministically.
// (Wire shapes verified against infra/chat/http/chatClient.ts validators.)

// show_verse: a bare scripture reference renders a verse card carrying the
// address.
test(
  qase(85, "Question type: find / show a verse"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    await mockChatStream(page, [
      action({
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
      }),
      delta("Krishna explains:\n\n[verse:source_x/2.13|BG 2.13]\n\nThe soul is eternal."),
      done(),
    ])

    await boot(page)
    await gotoTab(page, "chat")
    await askChat(page, "BG 2.13")

    const verse = page.locator(".verse-card-addr, .scripture-chip")
    await expect(verse.first()).toBeVisible({ timeout: 20_000 })
    await expect(verse.first()).toContainText("2.13")
  }
)

// locate: a "which chapter" question renders the chapter list card (the chip
// upgrades to a full canto/chapter list once the body arrives).
test(
  qase([87, 91], "Question type: locate a story / chapter list"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    await mockChatStream(page, [
      action({
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
      }),
      delta("That story is here:\n\n[chapter:source_bg/ch3|Chapter 3]\n\nA few verses in."),
      done(),
    ])

    await boot(page)
    await gotoTab(page, "chat")
    await askChat(page, "Which chapter is about karma-linux-client?")

    const chapter = page.locator(".chapter-card-list")
    await expect(chapter.first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(".chapter-card-item").first()).toContainText(/karma|action|work/i)
  }
)

// create_action (pdf): a "make a PDF" request renders the share-PDF action card
// listing the lecture(s) to export.
test(
  qase(86, "Question type: make a PDF"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    await mockChatStream(page, [
      action({
        kind: "share_pdf",
        id: "pdf12345",
        payload: {
          items: [
            {
              track_id: "track_x",
              transcript_key: "transcripts/track_x.txt",
              title: "The Eternal Soul",
              lang: "en",
              references: [],
              tags: [],
            },
          ],
        },
      }),
      delta("Here is the lecture as a PDF:\n\n[action:share_pdf|id=pdf12345]"),
      done(),
    ])

    await boot(page)
    await gotoTab(page, "chat")
    await askChat(page, "Make a PDF of this lecture")

    await expect(page.locator(".pdf-list").first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(".pdf-title").first()).toContainText("Eternal Soul")
  }
)

// The share-PDF action card itself: each listed lecture is a tappable row that
// kicks off the share/export.
test(
  qase(92, "Share-PDF action card"),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    await mockChatAuth(page)
    await mockChatStream(page, [
      action({
        kind: "share_pdf",
        id: "pdf67890",
        payload: {
          items: [
            {
              track_id: "track_y",
              transcript_key: "transcripts/track_y.txt",
              title: "On Detachment",
              lang: "en",
              references: [],
              tags: [],
            },
          ],
        },
      }),
      delta("Download it here:\n\n[action:share_pdf|id=pdf67890]"),
      done(),
    ])

    await boot(page)
    await gotoTab(page, "chat")
    await askChat(page, "Share this as a PDF")

    const row = page.locator(".pdf-row").first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText("Detachment")
    // The row is the interactive export trigger (tap fires the native share —
    // a no-op on web; we only assert it's an actionable control).
    await expect(row).toBeEnabled()
  }
)
