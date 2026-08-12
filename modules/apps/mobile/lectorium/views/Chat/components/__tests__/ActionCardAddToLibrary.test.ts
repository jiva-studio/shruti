import { describe, expect, it } from "vitest"
import { createSSRApp } from "vue"
import { renderToString } from "vue/server-renderer"
import ActionCardAddToLibrary from "../ActionCardAddToLibrary.vue"

/**
 * The card renders a tile, and a tile that reports "ready" is a button by
 * default — so what has to hold is that this one only claims it when the
 * surface says the lecture can actually be opened (#1788). Rendered rather
 * than mounted: the claim lives in the markup, which is exactly what a screen
 * reader reads.
 */

const PAYLOAD = {
  kind: "add_to_library",
  id: "cand-1",
  url: "https://archive.example/talks/0001.mp3",
  title: "A lecture the chat found",
  author: "Test Speaker",
  thumbnail: null,
} as const

async function render(props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp(ActionCardAddToLibrary, {
    actionId: "a-1",
    payload: PAYLOAD,
    state: "done",
    alreadyInLibrary: true,
    ...props,
  })
  app.config.globalProperties.$t = (key: string): string => key
  return renderToString(app)
}

describe("ActionCardAddToLibrary", () => {
  it("is a button once the added lecture can be opened", async () => {
    const html = await render({ selectable: true })
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })

  it("stays a picture when there is nothing to open", async () => {
    const html = await render({ selectable: false })
    expect(html).not.toContain('role="button"')
    expect(html).not.toContain("tabindex")
  })

  it("says nothing about being openable until the surface answers", async () => {
    // No `selectable` at all: the card must not fall back to the tile's own
    // "ready means tappable" default.
    const html = await render({})
    expect(html).not.toContain('role="button"')
  })

  it("is not a button while the lecture is still being fetched", async () => {
    const html = await render({
      selectable: true,
      alreadyInLibrary: false,
      state: "pending",
      liveStatus: { kind: "pending", label: "Downloading", percent: 40 },
    })
    expect(html).not.toContain('role="button"')
    expect(html).toContain("Downloading")
  })
})
