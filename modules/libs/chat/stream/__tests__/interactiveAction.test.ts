import { describe, expect, it } from "vitest"
import type { ChatActionPayload as WireChatActionPayload } from "@lib/contracts"
import { unwrapInteractiveAction } from "../interactiveAction.js"

/** A kind the contracts do not describe — what a newer server can put on the
 *  wire. The `null` branch under test exists for exactly this. */
function offContract(value: unknown): WireChatActionPayload {
  return value as WireChatActionPayload
}

const pdfItem = {
  trackId: "t1",
  lang: "en",
  title: "A lecture",
  author: "Someone",
  date: "2020-01-01",
  location: "Vrindavan",
  references: [{ shortName: "BG", fullName: null, sourceId: null, tokens: "2.13" }],
  tags: ["bhakti"],
  transcriptKey: "tracks/t1/en.json",
}

describe("unwrapInteractiveAction", () => {
  it("flattens a share_pdf", () => {
    const wire: WireChatActionPayload = {
      kind: "share_pdf",
      id: "a1",
      payload: { items: [pdfItem] },
    }
    expect(unwrapInteractiveAction(wire)).toEqual({
      kind: "share_pdf",
      id: "a1",
      items: [pdfItem],
    })
  })

  it("flattens an add_to_library", () => {
    const wire: WireChatActionPayload = {
      kind: "add_to_library",
      id: "a2",
      payload: {
        url: "https://example.test/x",
        title: "A lecture",
        author: "Someone",
        thumbnail: "https://example.test/x.jpg",
      },
    }
    expect(unwrapInteractiveAction(wire)).toEqual({
      kind: "add_to_library",
      id: "a2",
      url: "https://example.test/x",
      title: "A lecture",
      author: "Someone",
      thumbnail: "https://example.test/x.jpg",
    })
  })

  it("keeps an absent author and thumbnail null rather than inventing one", () => {
    const wire: WireChatActionPayload = {
      kind: "add_to_library",
      id: "a2",
      payload: { url: "u", title: "t", author: null, thumbnail: null },
    }
    expect(unwrapInteractiveAction(wire)).toMatchObject({ author: null, thumbnail: null })
  })

  it("flattens an enable_daily_reminder", () => {
    const wire: WireChatActionPayload = {
      kind: "enable_daily_reminder",
      id: "a3",
      payload: { time: "07:30" },
    }
    expect(unwrapInteractiveAction(wire)).toEqual({
      kind: "enable_daily_reminder",
      id: "a3",
      time: "07:30",
    })
  })

  it("flattens a configure_smart_library, filters and all", () => {
    const filters = { authorIds: ["au1"], tagIds: ["tg1"], languageCodes: ["en"] }
    const wire: WireChatActionPayload = {
      kind: "configure_smart_library",
      id: "a4",
      payload: { filters },
    }
    expect(unwrapInteractiveAction(wire)).toEqual({
      kind: "configure_smart_library",
      id: "a4",
      filters,
    })
  })

  it("flattens an upgrade_to_pro", () => {
    const wire: WireChatActionPayload = {
      kind: "upgrade_to_pro",
      id: "a5",
      payload: { reason: "autoScroll" },
    }
    expect(unwrapInteractiveAction(wire)).toEqual({
      kind: "upgrade_to_pro",
      id: "a5",
      reason: "autoScroll",
    })
  })

  it("refuses a kind this build does not know", () => {
    expect(
      unwrapInteractiveAction(offContract({ kind: "teleport", id: "a6", payload: {} }))
    ).toBeNull()
  })

  // The card kinds are folded elsewhere; this converter is only for the
  // interactive ones and must not claim them.
  it.each(["outline", "verse", "cite_transcript", "chapter", "media", "commentary"])(
    "refuses the card kind %s",
    (kind) => {
      expect(unwrapInteractiveAction(offContract({ kind, id: "a7", payload: {} }))).toBeNull()
    }
  )
})
