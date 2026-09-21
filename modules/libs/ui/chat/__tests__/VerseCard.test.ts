// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest"
import { createApp, h, nextTick, reactive, type Slots } from "vue"
import VerseCard from "../VerseCard.vue"
import type { UiChatVerseBody } from "../types.js"

interface Props {
  sourceId: string
  tokens: string
  locale: string
  caption?: string
  body?: UiChatVerseBody
  isPlaying?: boolean
  isPreparing?: boolean
  hasAudio?: boolean
}

interface Mounted {
  host: HTMLElement
  props: Props
  toggles: number
  text: (selector: string) => string | null
}

function mount(props: Props, slots: Slots = {}): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive(props)
  const m: Mounted = {
    host,
    props: state,
    toggles: 0,
    text: (sel) => host.querySelector(sel)?.textContent ?? null,
  }
  const app = createApp({
    render: () => h(VerseCard, { ...state, "onToggle-audio": () => (m.toggles += 1) }, slots),
  })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return m
}

const body: UiChatVerseBody = {
  addrLabel: "BG 2.13",
  sanskrit: "देहिनोऽस्मिन्\n\n\nयथा देहे",
  transliteration: "dehino 'smin",
  translation: { en: "As the embodied soul…", ru: "Воплощённая душа…" },
}

beforeAll(() => {
  // AutoHeight measures itself with one; jsdom ships none.
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
})

describe("VerseCard — chip fallback", () => {
  it("falls back to a chip when the verse body never streamed", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "en" })

    expect(m.host.querySelector(".scripture-block")).toBeNull()
    expect(m.text(".scripture-chip-caption")).toBe("2.13")
  })

  it("prefers the caption the server sent over the raw tokens", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "en", caption: "БГ 2.13" })

    expect(m.text(".scripture-chip-caption")).toBe("БГ 2.13")
  })

  it("ignores a caption that is only whitespace", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "en", caption: "   " })

    expect(m.text(".scripture-chip-caption")).toBe("2.13")
  })

  it("names the verse and its source for a screen reader", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "en", caption: "БГ 2.13" })

    expect(m.host.querySelector(".scripture-chip")!.getAttribute("aria-label")).toBe(
      "Verse БГ 2.13 (bg 2.13)"
    )
  })
})

describe("VerseCard — block card", () => {
  it("renders the address, sanskrit and translation of the streamed verse", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "en", body })

    expect(m.text(".verse-card-addr")).toBe("BG 2.13")
    expect(m.text(".verse-card-iast")).toBe("dehino 'smin")
    expect(m.text(".verse-card-translation")).toBe("As the embodied soul…")
    expect(m.host.querySelector(".scripture-chip")).toBeNull()
  })

  it("closes the blank lines gitabase leaves between half-verses", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "en", body })

    expect(m.text(".verse-card-sanskrit")).toBe("देहिनोऽस्मिन्\nयथा देहे")
  })

  it("shows the translation in the reader's locale", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "ru", body })

    expect(m.text(".verse-card-translation")).toBe("Воплощённая душа…")
  })

  it("follows the language the server answered in, not the ui locale", () => {
    const m = mount({
      sourceId: "bg",
      tokens: "2.13",
      locale: "en",
      body: { ...body, lang: "ru" },
    })

    expect(m.text(".verse-card-translation")).toBe("Воплощённая душа…")
  })

  it("falls back to English for a locale the verse was never translated into", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "sr", body })

    expect(m.text(".verse-card-translation")).toBe("As the embodied soul…")
  })

  it("shows whatever translation exists when there is no English one", () => {
    const m = mount({
      sourceId: "bg",
      tokens: "2.13",
      locale: "sr",
      body: { ...body, translation: { ru: "Воплощённая душа…" } },
    })

    expect(m.text(".verse-card-translation")).toBe("Воплощённая душа…")
  })

  it("leaves out the sanskrit line for a verse that carries none", () => {
    const m = mount({
      sourceId: "bg",
      tokens: "2.13",
      locale: "en",
      body: { ...body, sanskrit: "" },
    })

    expect(m.host.querySelector(".verse-card-sanskrit")).toBeNull()
  })

  it("falls back to the caption when the body has no address label", () => {
    const m = mount({
      sourceId: "bg",
      tokens: "2.13",
      locale: "en",
      caption: "БГ 2.13",
      body: { ...body, addrLabel: "" },
    })

    expect(m.text(".verse-card-addr")).toBe("БГ 2.13")
  })
})

describe("VerseCard — machine translation", () => {
  const mtBody: UiChatVerseBody = {
    ...body,
    mt: true,
    lang: "ru",
    transliteration: "дехино 'смин",
    transliterationOriginal: "dehino 'smin",
  }

  it("flags a machine-translated verse", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "ru", body: mtBody })

    expect(m.host.querySelector(".translation-notice")).not.toBeNull()
  })

  it("does not flag a verse shown in its own language", () => {
    const m = mount({
      sourceId: "bg",
      tokens: "2.13",
      locale: "en",
      body: { ...mtBody, lang: "en" },
    })

    expect(m.host.querySelector(".translation-notice")).toBeNull()
  })

  it("does not flag a translation with no original to fall back on", () => {
    const m = mount({
      sourceId: "bg",
      tokens: "2.13",
      locale: "ru",
      body: { ...mtBody, translation: { ru: "Воплощённая душа…" } },
    })

    expect(m.host.querySelector(".translation-notice")).toBeNull()
  })

  it("returns the whole verse to its original form on the toggle", async () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "ru", body: mtBody })

    expect(m.text(".verse-card-iast")).toBe("дехино 'смин")

    m.host.querySelector<HTMLButtonElement>(".translation-notice__toggle")!.click()
    await nextTick()

    expect(m.text(".verse-card-translation")).toBe("As the embodied soul…")
    expect(m.text(".verse-card-iast")).toBe("dehino 'smin")
  })
})

describe("VerseCard — recitation", () => {
  it("offers playback only for a verse that has a recording", () => {
    const silent = mount({ sourceId: "bg", tokens: "2.13", locale: "en", body })
    const recited = mount({
      sourceId: "bg",
      tokens: "2.13",
      locale: "en",
      body: { ...body, audioUrl: "https://cdn/bg-2-13.mp3" },
    })

    expect(silent.host.querySelector(".verse-play")).toBeNull()
    expect(recited.host.querySelector(".verse-play")).not.toBeNull()
  })

  it("lets the host override whether a recitation exists", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "en", body, hasAudio: true })

    expect(m.host.querySelector(".verse-play")).not.toBeNull()
  })

  it("asks the host to toggle the recitation", () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "en", body, hasAudio: true })

    m.host.querySelector<HTMLButtonElement>(".verse-play")!.click()

    expect(m.toggles).toBe(1)
  })

  it("shows the host's spinner while the recitation is buffering", () => {
    const m = mount(
      { sourceId: "bg", tokens: "2.13", locale: "en", body, hasAudio: true, isPreparing: true },
      { spinner: () => [h("i", { class: "dots" })] }
    )

    expect(m.host.querySelector(".verse-play .dots")).not.toBeNull()
    expect(m.host.querySelector(".verse-play svg")).toBeNull()
  })

  it("swaps the glyph once the recitation is playing", async () => {
    const m = mount({ sourceId: "bg", tokens: "2.13", locale: "en", body, hasAudio: true })

    const paused = m.host.querySelectorAll(".verse-play path").length
    m.props.isPlaying = true
    await nextTick()

    expect(paused).toBe(1)
    expect(m.host.querySelectorAll(".verse-play path")).toHaveLength(2)
  })
})
