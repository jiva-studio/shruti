// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h } from "vue"
import TranscriptBlockText from "../TranscriptBlockText.vue"

function mount(block: Record<string, unknown>): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  createApp({ render: () => h(TranscriptBlockText, { block } as never) }).mount(host)
  return host
}

describe("TranscriptBlockText", () => {
  it("renders a sentence with its inline emphasis", () => {
    const host = mount({ type: "sentence", start: 0, end: 1, text: "Chant *Hare Krishna*." })

    expect(host.querySelector(".tx-sentence span")!.innerHTML).toBe("Chant <em>Hare Krishna</em>. ")
  })

  it("hangs a verse chip off a sentence that cites one", () => {
    const host = mount({
      type: "sentence",
      start: 0,
      end: 1,
      text: "As it says,",
      reference: { tokens: ["2", "20"], label: "BG 2.20" },
    })

    expect(host.querySelector(".vref-chip")!.textContent).toBe("BG 2.20")
  })

  it("leaves a plain sentence without a chip", () => {
    const host = mount({ type: "sentence", start: 0, end: 1, text: "Plain." })

    expect(host.querySelector(".vref-chip")).toBeNull()
  })

  it("stacks the lines of a quoted verse under its number", () => {
    const host = mount({
      type: "verse:text",
      start: 0,
      end: 1,
      text: ["dehino 'smin", "yatha dehe"],
      original: ["देहिनोऽस्मिन्"],
      translation: "As the embodied soul…",
      reference: { tokens: ["2", "13"], label: "BG 2.13" },
    })

    expect(host.querySelector(".tx-verse-no")!.textContent).toBe("BG 2.13")
    expect([...host.querySelectorAll(".tx-verse-original")].map((e) => e.textContent)).toEqual([
      "देहिनोऽस्मिन्",
    ])
    expect([...host.querySelectorAll(".tx-verse-line")].map((e) => e.textContent)).toEqual([
      "dehino 'smin",
      "yatha dehe",
    ])
    expect(host.querySelector(".tx-verse-translation")!.textContent).toBe("As the embodied soul…")
  })

  it("numbers a verse by its tokens when the wire carried no label", () => {
    const host = mount({
      type: "verse:text",
      start: 0,
      end: 1,
      text: ["line"],
      reference: { tokens: ["2", "13"] },
    })

    expect(host.querySelector(".tx-verse-no")!.textContent).toBe("2.13")
  })

  it("leaves the number off a verse with no reference", () => {
    const host = mount({ type: "verse:text", start: 0, end: 1, text: ["line"] })

    expect(host.querySelector(".tx-verse-no")).toBeNull()
  })

  it("renders a standalone verse translation", () => {
    const host = mount({ type: "verse:translation", start: 0, end: 1, text: "The soul." })

    expect(host.querySelector(".tx-translation")!.textContent).toBe("The soul. ")
  })

  it("brackets a marker", () => {
    const host = mount({ type: "marker", start: 0, end: 1, text: "kirtan" })

    expect(host.querySelector(".tx-marker")!.textContent).toBe("[kirtan] ")
  })

  it("renders nothing for a layout-only paragraph", () => {
    const host = mount({ type: "paragraph", start: 0, end: 1 })

    expect(host.textContent).toBe("")
  })
})
