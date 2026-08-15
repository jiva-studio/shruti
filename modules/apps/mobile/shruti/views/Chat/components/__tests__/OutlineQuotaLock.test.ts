// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, ref } from "vue"
import type { ChatMessage } from "@shruti/stores/useChatStore.js"

/* -- Module doubles ----------------------------------------------------- */

const stub = (name: string) => defineComponent({ name, setup: () => () => h("div") })

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, te: () => false, tm: () => [], locale: ref("en") }),
  // Some store in the subtree builds the app-wide instance at import time.
  createI18n: () => ({ global: { t: (k: string) => k, locale: ref("en") } }),
}))
vi.mock("@ionic/vue", () => ({ IonSpinner: stub("IonSpinner") }))
vi.mock("../ChatFailureNotice.vue", () => ({ default: stub("ChatFailureNotice") }))
vi.mock("@shruti/stores/usePaywallStore.js", () => ({
  usePaywallStore: () => ({ requestOpen: vi.fn() }),
}))
vi.mock("@shruti/router/index.js", () => ({ default: { push: vi.fn() } }))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["en"]),
}))
vi.mock("@shruti/composables/useIngestStatusFor.js", () => ({
  useIngestStatusFor: () => () => undefined,
}))
vi.mock("@shruti/composables/useOpenAddedLecture.js", () => ({
  useOpenAddedLecture: () => ({ canOpen: () => false, open: vi.fn() }),
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({
  useChatStore: () => ({ sending: false, executeAction: vi.fn() }),
}))
vi.mock("@shruti/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ ensureLoaded: vi.fn(), hasSource: () => false }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    storagePublicUrl: { get: (p: string) => p },
    // The container resolves the lecture title on mount; an empty repo just
    // leaves the header off, which is irrelevant to the chapter rows.
    repositories: () => ({ tracks: { getById: async () => null } }),
  }),
}))
vi.mock("../../composables/useChatExportMarkdown.js", () => ({
  useChatExportMarkdown: () => ({ exportMarkdown: ref(""), citeTrackIds: ref([]) }),
}))
vi.mock("../ChatMessageActions.vue", () => ({ default: stub("ChatMessageActions") }))
vi.mock("../CitationCardContainer.vue", () => ({ default: stub("CitationCardContainer") }))
vi.mock("../ChatChips.vue", () => ({ default: stub("ChatChips") }))
vi.mock("../CitationActionSheet.vue", () => ({ default: stub("CitationActionSheet") }))
vi.mock("@lib/ui/chat/StatusPill.vue", () => ({ default: stub("StatusPill") }))

// Imported after the mocks so the whole bubble subtree — token renderer,
// outline container, the real OutlineCard — resolves against them.
const { default: ChatMessageBubble } = await import("../ChatMessageBubble.vue")

/* -- Fixtures ----------------------------------------------------------- */

const TRACK_ID = "t1"

/** An answer carrying an outline card with two chapters. */
function outlineMessage(): ChatMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    content: `Here it is [outline:${TRACK_ID}]`,
    createdAt: 1_700_000_000_000,
    outlines: {
      [TRACK_ID]: {
        items: [
          { startMs: 0, title: "Opening" },
          { startMs: 60_000, title: "The point" },
        ],
      },
    },
  } as unknown as ChatMessage
}

let teardown: (() => void) | null = null

function mountBubble(quotaLocked: boolean): { root: HTMLElement; picked: unknown[] } {
  const picked: unknown[] = []
  const Host = defineComponent({
    setup: () => () =>
      h(ChatMessageBubble, {
        message: outlineMessage(),
        quotaLocked,
        onPickChapter: (args: unknown) => picked.push(args),
      }),
  })
  const app = createApp(Host)
  const root = document.createElement("div")
  document.body.appendChild(root)
  app.mount(root)
  teardown = () => {
    app.unmount()
    root.remove()
  }
  return { root, picked }
}

function chapterButtons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button.chapter"))
}

/**
 * A chapter row asks for a recap turn, and `sendMessage` refuses one while
 * the daily lock is armed. Every other send-capable control in the thread
 * already dims; the outline card sat lit among them and ate the tap.
 */
describe("outline chapter rows under the quota lock (#1841)", () => {
  afterEach(() => {
    teardown?.()
    teardown = null
  })

  it("dispatches a chapter pick while the quota is open", async () => {
    const { root, picked } = mountBubble(false)
    await nextTick()

    const rows = chapterButtons(root)
    expect(rows).toHaveLength(2)
    expect(rows.every((b) => b.disabled)).toBe(false)

    rows[1].click()
    await nextTick()

    expect(picked).toEqual([
      {
        trackId: TRACK_ID,
        item: { startMs: 60_000, title: "The point" },
        nextItem: null,
      },
    ])
  })

  it("goes dead and dims while the quota lock is armed", async () => {
    const { root, picked } = mountBubble(true)
    await nextTick()

    const rows = chapterButtons(root)
    expect(rows).toHaveLength(2)
    expect(rows.every((b) => b.disabled)).toBe(true)
    // The dimming is the whole point — a dead-but-bright row reads as broken.
    expect(getComputedStyle(rows[0]).opacity).toBe("0.45")

    rows[0].click()
    await nextTick()

    expect(picked).toEqual([])
  })
})
