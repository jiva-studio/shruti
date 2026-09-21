// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest"
import { createApp, h, nextTick, reactive, type Slots } from "vue"
import CitationCard from "../CitationCard.vue"
import CommentaryCard from "../CommentaryCard.vue"

interface CiteProps {
  caption?: string
  body?: { text: string }
  trackTitle?: string
  authorName?: string
  trackDate?: string
  reference?: string
  metaReady?: boolean
  cardLabel?: string
  chipFallbackLabel?: string
  bodyHtml?: string
  isMt?: boolean
  showOriginal?: boolean
}

interface Mounted<P> {
  host: HTMLElement
  props: P
  activations: number
  originals: boolean[]
}

function mountCite(props: CiteProps, slots: Slots = {}): Mounted<CiteProps> {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive(props)
  const m: Mounted<CiteProps> = { host, props: state, activations: 0, originals: [] }
  const app = createApp({
    render: () =>
      h(
        CitationCard,
        {
          ...state,
          onActivate: () => (m.activations += 1),
          "onUpdate:show-original": (v: boolean) => m.originals.push(v),
        },
        slots
      ),
  })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return m
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
})

describe("CitationCard", () => {
  it("falls back to a chip while the transcript has not streamed", () => {
    const m = mountCite({ caption: "on surrender" })

    expect(m.host.querySelector(".citation-card")).toBeNull()
    expect(m.host.querySelector(".citation-chip-fallback")!.textContent).toBe("on surrender")
  })

  it("labels a captionless chip with the host's fallback", () => {
    const m = mountCite({ chipFallbackLabel: "From a lecture" })

    expect(m.host.querySelector(".citation-chip-fallback")!.textContent).toBe("From a lecture")
  })

  it("lets the host replace the chip with its own", () => {
    const m = mountCite({ caption: "x" }, { chip: () => [h("span", { class: "own-chip" })] })

    expect(m.host.querySelector(".citation-chip-fallback")).toBeNull()
    expect(m.host.querySelector(".own-chip")).not.toBeNull()
  })

  it("holds a skeleton at the card's size until the metadata settles", () => {
    const m = mountCite({ body: { text: "A line." }, bodyHtml: "A line.", metaReady: false })

    expect(m.host.querySelector(".citation-card--loading")).not.toBeNull()
    expect(m.host.querySelector(".excerpt-body")).toBeNull()
  })

  it("reveals the quote once the metadata is in", async () => {
    const m = mountCite({ body: { text: "A line." }, bodyHtml: "A line.", metaReady: false })

    m.props.metaReady = true
    await nextTick()

    expect(m.host.querySelector(".citation-card--loading")).toBeNull()
    expect(m.host.querySelector(".highlight-text span")!.innerHTML).toBe("A line.")
  })

  it("shows the resolved attribution on the card", () => {
    const m = mountCite({
      body: { text: "A line." },
      bodyHtml: "A line.",
      trackTitle: "Morning Walk",
      authorName: "Prabhupada",
      reference: "BG 2.20",
    })

    expect(m.host.querySelector(".author")!.textContent).toBe("Prabhupada")
    expect(m.host.querySelector(".title")!.textContent).toBe("Morning Walk")
  })

  it("names the lecture to a screen reader, or the host's fallback label", () => {
    const titled = mountCite({
      body: { text: "A line." },
      bodyHtml: "A line.",
      trackTitle: "Morning Walk",
    })
    const untitled = mountCite({
      body: { text: "A line." },
      bodyHtml: "A line.",
      cardLabel: "Citation details",
    })

    expect(titled.host.querySelector(".citation-card")!.getAttribute("aria-label")).toBe(
      "Morning Walk"
    )
    expect(untitled.host.querySelector(".citation-card")!.getAttribute("aria-label")).toBe(
      "Citation details"
    )
  })

  it("asks the host to act when the card is tapped", () => {
    const m = mountCite({ body: { text: "A line." }, bodyHtml: "A line." })

    m.host.querySelector<HTMLElement>(".citation-card")!.click()

    expect(m.activations).toBe(1)
  })

  it("does nothing when a host listens for no activation", () => {
    const m = mountCite({ caption: "x" })

    m.host.querySelector<HTMLElement>(".citation-chip-line")!.click()

    expect(m.activations).toBe(0)
  })

  it("hands the translation toggle back to the host", () => {
    const m = mountCite({ body: { text: "A line." }, bodyHtml: "A line.", isMt: true })

    m.host.querySelector<HTMLButtonElement>(".translation-notice__toggle")!.click()

    expect(m.originals).toEqual([true])
  })

  it("carries the host's player above the quote", () => {
    const m = mountCite(
      { body: { text: "A line." }, bodyHtml: "A line." },
      { player: () => [h("div", { class: "own-player" })] }
    )

    expect(m.host.querySelector(".own-player")).not.toBeNull()
  })
})

describe("CommentaryCard", () => {
  function mountCommentary(props: Record<string, unknown>, slots: Slots = {}): Mounted<never> {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const m = { host, props: undefined as never, activations: 0, originals: [] as boolean[] }
    const app = createApp({
      render: () =>
        h(
          CommentaryCard,
          { ...props, "onUpdate:show-original": (v: boolean) => m.originals.push(v) },
          slots
        ),
    })
    app.config.globalProperties.$t = (key: string) => key
    app.mount(host)
    return m
  }

  const body = { authorName: "Prabhupada", addrLabel: "BG 2.20" }

  it("renders nothing for a commentary the message never carried", () => {
    const m = mountCommentary({ bodyHtml: "A purport." })

    expect(m.host.querySelector(".commentary-card")).toBeNull()
  })

  it("quotes the purport with its author and reference", () => {
    const m = mountCommentary({ body, bodyHtml: "A <em>purport</em>." })

    expect(m.host.querySelector(".highlight-text span")!.innerHTML).toBe("A <em>purport</em>.")
    expect(m.host.querySelector(".author")!.textContent).toBe("Prabhupada")
    expect(m.host.querySelector(".meta")!.textContent).toBe("BG 2.20")
  })

  it("offers the translation toggle only for a machine-translated purport", () => {
    const plain = mountCommentary({ body, bodyHtml: "A purport." })
    const translated = mountCommentary({ body, bodyHtml: "Пурпорт.", isMt: true })

    expect(plain.host.querySelector(".translation-notice")).toBeNull()
    expect(translated.host.querySelector(".translation-notice")).not.toBeNull()
  })

  it("hands the toggle back to the host", () => {
    const m = mountCommentary({ body, bodyHtml: "Пурпорт.", isMt: true, showOriginal: true })

    m.host.querySelector<HTMLButtonElement>(".translation-notice__toggle")!.click()

    expect(m.originals).toEqual([false])
  })

  it("lets a host without vue-i18n supply its own notice chrome", () => {
    const m = mountCommentary(
      { body, bodyHtml: "Пурпорт.", isMt: true },
      {
        "translation-notice": ({ toggle }: { toggle: () => void }) => [
          h("button", { class: "own-notice", onClick: () => toggle() }),
        ],
      }
    )

    expect(m.host.querySelector(".translation-notice")).toBeNull()
    m.host.querySelector<HTMLButtonElement>(".own-notice")!.click()

    expect(m.originals).toEqual([true])
  })
})
