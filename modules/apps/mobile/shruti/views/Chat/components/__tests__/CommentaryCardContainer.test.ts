// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, type App } from "vue"
import type { ChatCommentaryBody } from "@lib/domain/chatMessage.js"
import CommentaryCardContainer from "../CommentaryCardContainer.vue"

type ContainerProps = InstanceType<typeof CommentaryCardContainer>["$props"]

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    disconnect(): void {}
  }
)

function body(over: Partial<ChatCommentaryBody> = {}): ChatCommentaryBody {
  return {
    text: "The soul is **never** born.",
    authorName: "A.C. Bhaktivedanta Swami",
    addrLabel: "BG 2.20",
    commentaryKind: "commentary",
    ...over,
  }
}

let app: App | null = null

function render(props: ContainerProps): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(defineComponent({ setup: () => () => h(CommentaryCardContainer, props) }))
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return host
}

const cardText = (host: HTMLElement): string =>
  host.querySelector(".highlight-text")?.textContent?.trim() ?? ""

const toggle = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector(".translation-notice__toggle")

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
})

describe("a commentary whose body never arrived", () => {
  it("renders nothing, so the marker simply disappears", () => {
    const host = render({})
    expect(host.querySelector(".commentary-card")).toBeNull()
    expect(host.textContent?.trim()).toBe("")
  })
})

describe("a commentary with a body", () => {
  it("shows the quote with its author and reference", () => {
    const host = render({ body: body() })
    expect(cardText(host)).toBe("The soul is never born.")
    expect(host.querySelector(".author")?.textContent).toBe("A.C. Bhaktivedanta Swami")
    expect(host.querySelector(".meta")?.textContent).toBe("BG 2.20")
  })

  it("renders the quote's inline markdown rather than printing the asterisks", () => {
    const host = render({ body: body() })
    expect(host.querySelector(".highlight-text strong")?.textContent).toBe("never")
  })

  it("offers no translation toggle for a quote in its own language", () => {
    const host = render({ body: body() })
    expect(toggle(host)).toBeNull()
  })

  it("offers no toggle for a machine translation with no original to flip to", () => {
    const host = render({ body: body({ mt: true }) })
    expect(toggle(host)).toBeNull()
    expect(cardText(host)).toBe("The soul is never born.")
  })
})

describe("a machine-translated commentary", () => {
  const translated = body({ mt: true, textOriginal: "Душа никогда не рождается." })

  it("shows the translation first, with a way back to the original", () => {
    const host = render({ body: translated })
    expect(cardText(host)).toBe("The soul is never born.")
    expect(toggle(host)).not.toBeNull()
  })

  it("swaps in the verbatim original when the reader asks for it", async () => {
    const host = render({ body: translated })
    toggle(host)!.click()
    await nextTick()

    expect(cardText(host)).toBe("Душа никогда не рождается.")
  })

  it("swaps back to the translation on a second tap", async () => {
    const host = render({ body: translated })
    toggle(host)!.click()
    await nextTick()
    toggle(host)!.click()
    await nextTick()

    expect(cardText(host)).toBe("The soul is never born.")
  })
})
