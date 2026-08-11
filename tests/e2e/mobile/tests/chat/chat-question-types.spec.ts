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

// Same locate answer, but with citation translation on: the server ships each
// title machine-translated with the source-language one on `title_original`,
// plus a payload-level `mt`. (Issue #1611 part 2.)
const CHAPTER_MT = action({
  kind: "chapter",
  id: "ch2",
  payload: {
    source_id: "source_sb",
    region_token: "c5",
    region_label: "Песнь 5",
    mt: true,
    chapters: [
      {
        tokens: "5.5",
        title: "Наставления Господа Ришабхадевы",
        title_original: "Lord Ṛṣabhadeva's Teachings to His Sons",
      },
      { tokens: "5.6", title: "Игры Господа Ришабхадевы", title_original: "Lord Ṛṣabhadeva's Pastimes" },
    ],
  },
})

// A media clip card. `title` is the curated clip title and `speaker` / `date`
// are the two halves of the attribution line under it. (Issue #1611 part 1.)
const MEDIA = action({
  kind: "media",
  id: "m1",
  payload: {
    id: "clip1",
    url: "public/media/clip1.mp4",
    type: "video",
    title: "Are you all right?",
    speaker: "Gopalasyapriya dasi",
    date: "1975",
    text: "A short exchange from the morning walk.",
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
  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")
  await step(page, 85, 0, async () => {
    await askChat(page, "BG 2.13")
    // The mock ships the full verse body, so VerseCard renders the block card
    // (not the inline chip fallback) — assert the card's address header itself.
    const verse = page.locator(".verse-card-addr")
    await expect(verse.first()).toBeVisible({ timeout: 20_000 })
    await expect(verse.first()).toContainText("2.13")
  })
})

// locate intent: a "which chapter" question renders the chapter list card. The
// same chapter marker upgrades into a full multi-row list (one row per chapter),
// each row naming the chapter's topics — not a bare chip. (Merged 87 + 91.)
test(qase(87, caseTitle(87)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(page, [CHAPTER, delta("That story is here:\n\n[chapter:source_bg/ch3|Chapter 3]"), done()])
  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")
  await step(page, 87, 0, async () => {
    await askChat(page, "Which chapter is about karma-linux-client?")
    await expect(page.locator(".chapter-card-list").first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(".chapter-card-item").first()).toContainText(/karma|action|work/i)
    await expect(page.locator(".chapter-card-item")).toHaveCount(2)
  })
})

// create_action (pdf) intent: a "make a PDF" request renders the share-PDF card,
// listing each lecture as an actionable, tappable export row (tap fires the
// native share — a no-op on web; we assert it's an enabled control, not a bare
// chip). (Merged 86 + 92.)
test(qase(86, caseTitle(86)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(page, [
    sharePdf("pdf12345", "The Eternal Soul", "track_x"),
    delta("Here is the lecture as a PDF:\n\n[action:share_pdf|id=pdf12345]"),
    done(),
  ])
  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")
  await step(page, 86, 0, async () => {
    await askChat(page, "Make a PDF of this lecture")
    await expect(page.locator(".pdf-list").first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(".pdf-title").first()).toContainText("Eternal Soul")
    const row = page.locator(".pdf-row").first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toBeEnabled()
  })
})

// media intent: a "show me the clip" answer renders the media card with the
// CURATED clip title on the bold line and "speaker · date" as the attribution
// under it — not the same name printed twice with the title lost. (#1611)
test(qase(198, caseTitle(198)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(page, [
    MEDIA,
    delta("Here is the moment:\n\n[media:clip1|Are you all right?]"),
    done(),
  ])
  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")
  await step(page, 198, 0, async () => {
    await askChat(page, "Show me that clip")
    const title = page.locator(".media-card-title").first()
    await expect(title).toBeVisible({ timeout: 20_000 })
    await expect(title).toHaveText("Are you all right?")
  })
  await step(page, 198, 1, async () => {
    // `date` used to be dropped by the parser whitelist, collapsing the
    // attribution to the speaker alone — under a "title" that was itself the
    // server's "<speaker> · <date>" label.
    const attribution = page.locator(".media-card-attribution").first()
    await expect(attribution).toBeVisible({ timeout: 20_000 })
    await expect(attribution).toHaveText("Gopalasyapriya dasi · 1975")
    // The attribution is not a second copy of the title.
    await expect(page.locator(".media-card-title").first()).not.toHaveText(
      "Gopalasyapriya dasi · 1975"
    )
  })
})

// locate intent with citation translation on: the chapter list is machine
// translated, so the card must carry the same "translated automatically"
// disclosure + view-original toggle its four sibling cards have. (#1611)
test(qase(199, caseTitle(199)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(page, [
    CHAPTER_MT,
    delta("Эта история здесь:\n\n[chapter:source_sb/c5|Песнь 5]"),
    done(),
  ])
  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")
  await step(page, 199, 0, async () => {
    await askChat(page, "Где рассказана история Ришабхадевы?")
    await expect(page.locator(".chapter-card-list").first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(".chapter-card-title").first()).toContainText("Ришабхадевы")
    // ChapterCard had no TranslationNotice at all — MT'd canto titles shipped
    // as if they were the book's own wording.
    await expect(page.locator(".translation-notice").first()).toBeVisible({ timeout: 20_000 })
  })
  await step(page, 199, 1, async () => {
    // …and the toggle actually reaches the source-language title.
    await page.locator(".translation-notice__toggle").first().click()
    await expect(page.locator(".chapter-card-title").first()).toContainText("Ṛṣabhadeva")
  })
})
