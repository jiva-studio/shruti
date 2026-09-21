// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h, nextTick, reactive } from "vue"
import ChapterCard from "../ChapterCard.vue"
import type { UiChatChapterBody } from "../types.js"

interface Props {
  sourceId: string
  regionToken: string
  caption?: string
  body?: UiChatChapterBody
}

function mount(props: Props): { host: HTMLElement; titles: () => (string | null)[] } {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive(props)
  const app = createApp({ render: () => h(ChapterCard, { ...state }) })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return {
    host,
    titles: () => [...host.querySelectorAll(".chapter-card-title")].map((e) => e.textContent),
  }
}

const body: UiChatChapterBody = {
  regionLabel: "Canto 5",
  chapters: [
    { tokens: "5.5", title: "The Instructions of Rsabhadeva" },
    { tokens: "5.6", title: "The Activities of Rsabhadeva" },
  ],
}

describe("ChapterCard", () => {
  it("falls back to a chip when the region body never streamed", () => {
    const m = mount({ sourceId: "sb", regionToken: "5" })

    expect(m.host.querySelector(".scripture-block")).toBeNull()
    expect(m.host.querySelector(".scripture-chip-caption")!.textContent).toBe("5")
  })

  it("names the region on the chip when the body is missing", () => {
    const m = mount({ sourceId: "sb", regionToken: "5", caption: "Песнь 5" })

    expect(m.host.querySelector(".scripture-chip-caption")!.textContent).toBe("Песнь 5")
    expect(m.host.querySelector(".scripture-chip")!.getAttribute("aria-label")).toBe(
      "Scripture location Песнь 5"
    )
  })

  it("lists the chapters the narrative spans", () => {
    const m = mount({ sourceId: "sb", regionToken: "5", body })

    expect(m.host.querySelector(".chapter-card-region")!.textContent).toBe("Canto 5")
    expect(m.titles()).toEqual(["The Instructions of Rsabhadeva", "The Activities of Rsabhadeva"])
  })

  it("numbers a chapter by the last segment of its address", () => {
    const m = mount({
      sourceId: "cc",
      regionToken: "madhya",
      body: {
        regionLabel: "Madhya",
        chapters: [
          { tokens: "8", title: "Talks with Ramananda Raya" },
          { tokens: "2.7,2.8", title: "Two at once" },
        ],
      },
    })

    expect([...m.host.querySelectorAll(".chapter-card-num")].map((e) => e.textContent)).toEqual([
      "8",
      "7",
    ])
  })

  it("flags machine-translated titles and flips them back to the source wording", async () => {
    const m = mount({
      sourceId: "sb",
      regionToken: "5",
      body: {
        ...body,
        mt: true,
        chapters: [
          {
            tokens: "5.5",
            title: "Наставления Ришабхадевы",
            titleOriginal: "The Instructions of Rsabhadeva",
          },
        ],
      },
    })

    expect(m.titles()).toEqual(["Наставления Ришабхадевы"])

    m.host.querySelector<HTMLButtonElement>(".translation-notice__toggle")!.click()
    await nextTick()

    expect(m.titles()).toEqual(["The Instructions of Rsabhadeva"])
  })

  it("offers no toggle when no source title came along", () => {
    const m = mount({
      sourceId: "sb",
      regionToken: "5",
      body: { ...body, mt: true },
    })

    expect(m.host.querySelector(".translation-notice")).toBeNull()
  })

  it("offers no toggle for titles in their own language", () => {
    const m = mount({ sourceId: "sb", regionToken: "5", body })

    expect(m.host.querySelector(".translation-notice")).toBeNull()
  })
})
