// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, type App } from "vue"
import type { ChatVerseBody } from "@lib/domain/chatMessage.js"

/* -- Module doubles ----------------------------------------------------- */

const downloads: string[] = []
let downloadFails = false

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    disconnect(): void {}
  }
)

vi.mock("@ionic/vue", () => ({
  IonSpinner: defineComponent({ name: "IonSpinner", setup: () => () => h("span") }),
}))
vi.mock("@lectorium/composables/useCachedExcerptUrl.js", () => ({
  useCachedExcerptUrl: () => ({
    resolve: async (remote: () => string) => {
      const url = remote()
      if (downloadFails) throw new Error("offline")
      downloads.push(url)
      return `file:///cache/${downloads.length}.mp3`
    },
  }),
}))

const { default: VerseCardContainer } = await import("../VerseCardContainer.vue")

/* -- A playable audio element ------------------------------------------- */

const pausedState = new WeakMap<HTMLMediaElement, boolean>()

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return pausedState.get(this) ?? true
    },
  })
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    pausedState.set(this, false)
    this.dispatchEvent(new Event("play"))
    return Promise.resolve()
  }
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    if (pausedState.get(this) === false) {
      pausedState.set(this, true)
      this.dispatchEvent(new Event("pause"))
    }
  }
})

/* -- Fixtures ----------------------------------------------------------- */

function body(over: Partial<ChatVerseBody> = {}): ChatVerseBody {
  return {
    addrLabel: "BG 2.13",
    sanskrit: "dehino 'smin",
    transliteration: "dehino 'smin yathā dehe",
    translation: { en: "As the embodied soul" },
    ...over,
  } as ChatVerseBody
}

/* -- Harness ------------------------------------------------------------ */

let app: App | null = null

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
  downloads.length = 0
  downloadFails = false
  vi.restoreAllMocks()
})

function render(props: {
  sourceId?: string
  tokens?: string
  caption?: string
  body?: ChatVerseBody
  locale?: string
}): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(VerseCardContainer, {
          sourceId: props.sourceId ?? "bg",
          tokens: props.tokens ?? "2.13",
          caption: props.caption,
          body: props.body,
          locale: props.locale ?? "en",
        }),
    })
  )
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return host
}

const text = (host: HTMLElement, sel: string): string =>
  host.querySelector(sel)?.textContent?.trim() ?? ""

const playButton = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector(".verse-play")

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await nextTick()
}

describe("a verse whose body never arrived", () => {
  it("degrades to a chip captioned by the tokens", () => {
    const host = render({})
    expect(host.querySelector(".verse-card-addr")).toBeNull()
    expect(host.textContent).toContain("2.13")
  })

  it("prefers the caption the server sent for the chip", () => {
    const host = render({ caption: " BG 2.13 " })
    expect(host.textContent).toContain("BG 2.13")
  })

  it("renders no audio element to download from", () => {
    const host = render({})
    expect(host.querySelector("audio")).toBeNull()
  })
})

describe("a verse with a body", () => {
  it("renders the address, the sanskrit and the translation", () => {
    const host = render({ body: body() })
    expect(text(host, ".verse-card-addr")).toBe("BG 2.13")
    expect(text(host, ".verse-card-sanskrit")).toBe("dehino 'smin")
    expect(text(host, ".verse-card-translation")).toBe("As the embodied soul")
  })

  it("falls back to the tokens when the body carries no address", () => {
    const host = render({ body: body({ addrLabel: "" }) })
    expect(text(host, ".verse-card-addr")).toBe("2.13")
  })

  it("leaves out the sanskrit line the body does not carry", () => {
    const host = render({ body: body({ sanskrit: "" }) })
    expect(host.querySelector(".verse-card-sanskrit")).toBeNull()
    expect(text(host, ".verse-card-translation")).toBe("As the embodied soul")
  })

  it("collapses blank lines inside the sanskrit", () => {
    const host = render({ body: body({ sanskrit: "line one\n\n\nline two" }) })
    expect(text(host, ".verse-card-sanskrit")).toBe("line one\nline two")
  })

  it("shows the translation in the answer language the body names", () => {
    const host = render({
      locale: "en",
      body: body({ lang: "ru", translation: { en: "English", ru: "Русский" } }),
    })
    expect(text(host, ".verse-card-translation")).toBe("Русский")
  })

  it("falls back to English when the locale has no translation", () => {
    const host = render({
      locale: "hi",
      body: body({ translation: { en: "English" } }),
    })
    expect(text(host, ".verse-card-translation")).toBe("English")
  })

  it("shows whatever translation exists when English is missing too", () => {
    const host = render({ locale: "hi", body: body({ translation: { sr: "Srpski" } }) })
    expect(text(host, ".verse-card-translation")).toBe("Srpski")
  })

  it("shows no translation line for an empty translation map", () => {
    const host = render({ body: body({ translation: {} }) })
    expect(host.querySelector(".verse-card-translation")).toBeNull()
  })
})

describe("the recitation button", () => {
  const withAudio = body({ audioUrl: "https://cdn.example/verses/bg-2-13.mp3" })

  it("is absent when the body carries no recitation", () => {
    const host = render({ body: body() })
    expect(playButton(host)).toBeNull()
    expect(host.querySelector("audio")).toBeNull()
  })

  it("appears with a hidden audio element when there is one", () => {
    const host = render({ body: withAudio })
    expect(playButton(host)).not.toBeNull()
    expect(host.querySelector("audio")?.getAttribute("preload")).toBe("none")
  })

  it("downloads the recitation on the first tap and plays it", async () => {
    const host = render({ body: withAudio })
    playButton(host)!.click()
    await settle()

    expect(downloads).toEqual(["https://cdn.example/verses/bg-2-13.mp3"])
    const audio = host.querySelector("audio") as HTMLAudioElement
    expect(audio.src).toBe("file:///cache/1.mp3")
    expect(audio.paused).toBe(false)
  })

  it("plays the local copy on the next tap instead of downloading again", async () => {
    const host = render({ body: withAudio })
    playButton(host)!.click()
    await settle()
    playButton(host)!.click()
    await settle()
    playButton(host)!.click()
    await settle()

    expect(downloads).toHaveLength(1)
    expect((host.querySelector("audio") as HTMLAudioElement).paused).toBe(false)
  })

  it("pauses on a second tap", async () => {
    const host = render({ body: withAudio })
    playButton(host)!.click()
    await settle()
    playButton(host)!.click()
    await settle()

    expect((host.querySelector("audio") as HTMLAudioElement).paused).toBe(true)
  })

  it("stays silent and leaves the button usable when the download fails", async () => {
    downloadFails = true
    const host = render({ body: withAudio })
    playButton(host)!.click()
    await settle()

    expect((host.querySelector("audio") as HTMLAudioElement).paused).toBe(true)
    expect(host.querySelector(".verse-play-spinner")).toBeNull()
    expect(playButton(host)).not.toBeNull()
  })

  it("shows the pause glyph while playing and the play glyph once it ends", async () => {
    const host = render({ body: withAudio })
    playButton(host)!.click()
    await settle()
    expect(host.querySelectorAll(".verse-play svg path")).toHaveLength(2)

    const audio = host.querySelector("audio") as HTMLAudioElement
    audio.dispatchEvent(new Event("ended"))
    await nextTick()

    expect(host.querySelectorAll(".verse-play svg path")).toHaveLength(1)
  })

  it("re-shows the spinner on a buffer underrun and drops it on an error", async () => {
    const host = render({ body: withAudio })
    playButton(host)!.click()
    await settle()

    const audio = host.querySelector("audio") as HTMLAudioElement
    audio.dispatchEvent(new Event("waiting"))
    await nextTick()
    expect(host.querySelector(".verse-play-spinner")).not.toBeNull()

    audio.dispatchEvent(new Event("error"))
    await nextTick()
    expect(host.querySelector(".verse-play-spinner")).toBeNull()
    expect(host.querySelectorAll(".verse-play svg path")).toHaveLength(1)
  })
})
