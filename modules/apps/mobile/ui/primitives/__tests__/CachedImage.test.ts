// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, ref, type App, type Ref } from "vue"
import type { IRemoteFilesStorage } from "@kit/infra"
import CachedImage from "../CachedImage.vue"
import { ASSET_FAILOVER_KEY, FILES_STORAGE_KEY } from "../filesStorageKey.js"

type CachedImageProps = InstanceType<typeof CachedImage>["$props"]

function storageOf(get: (url: string) => Promise<string>): IRemoteFilesStorage {
  return {
    get,
    getText: async () => "",
    has: async () => false,
    delete: async () => undefined,
    clearAll: async () => undefined,
  }
}

let app: App | null = null

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
  vi.useRealTimers()
})

interface Rendered {
  readonly host: HTMLElement
  readonly loadedEvents: number[]
  readonly url: Ref<string | undefined>
  readonly img: () => HTMLImageElement | null
}

function render(
  props: Partial<CachedImageProps>,
  wiring: {
    storage?: IRemoteFilesStorage
    failover?: (url: string) => Promise<string | null>
  } = {}
): Rendered {
  const loadedEvents: number[] = []
  const url = ref(props.url)
  const host = document.createElement("div")
  document.body.appendChild(host)
  const Host = defineComponent({
    setup: () => () =>
      h(CachedImage, {
        url: url.value,
        alt: props.alt,
        onLoaded: () => void loadedEvents.push(1),
      }),
  })
  app = createApp(Host)
  if (wiring.storage) app.provide(FILES_STORAGE_KEY, wiring.storage)
  if (wiring.failover) app.provide(ASSET_FAILOVER_KEY, wiring.failover)
  app.mount(host)
  return { host, loadedEvents, url, img: () => host.querySelector("img") }
}

describe("what the cover renders", () => {
  it("shows nothing until the cached URL resolves, leaving the placeholder up", async () => {
    const rendered = render(
      { url: "https://cdn.example/cover.jpg" },
      { storage: storageOf(() => new Promise(() => {})) }
    )
    await vi.runAllTimersAsync()
    expect(rendered.img()).toBeNull()
  })

  it("shows nothing at all when there is no cover to show", async () => {
    const rendered = render({}, { storage: storageOf(async () => "blob:cached") })
    await vi.runAllTimersAsync()
    expect(rendered.img()).toBeNull()
  })

  it("serves the cached copy, not the remote URL", async () => {
    const rendered = render(
      { url: "https://cdn.example/cover.jpg", alt: "Lecture cover" },
      { storage: storageOf(async () => "blob:cached") }
    )
    await vi.runAllTimersAsync()

    expect(rendered.img()?.getAttribute("src")).toBe("blob:cached")
    expect(rendered.img()?.getAttribute("alt")).toBe("Lecture cover")
  })

  it("falls back to the remote URL when nothing caches images", async () => {
    const rendered = render({ url: "https://cdn.example/cover.jpg" })
    await vi.runAllTimersAsync()
    expect(rendered.img()?.getAttribute("src")).toBe("https://cdn.example/cover.jpg")
  })

  it("carries an empty alt when none was given, rather than none at all", async () => {
    const rendered = render({ url: "https://cdn.example/cover.jpg" })
    await vi.runAllTimersAsync()
    expect(rendered.img()?.getAttribute("alt")).toBe("")
  })
})

describe("revealing it once it has decoded", () => {
  it("stays invisible until the browser says it decoded", async () => {
    const rendered = render(
      { url: "https://cdn.example/cover.jpg" },
      { storage: storageOf(async () => "blob:cached") }
    )
    await vi.runAllTimersAsync()

    expect(rendered.img()?.classList.contains("is-loaded")).toBe(false)
    expect(rendered.loadedEvents).toEqual([])

    rendered.img()!.dispatchEvent(new Event("load"))
    await vi.runAllTimersAsync()

    expect(rendered.img()?.classList.contains("is-loaded")).toBe(true)
    expect(rendered.loadedEvents).toEqual([1])
  })

  it("hides again while a new cover is still decoding", async () => {
    const urls = ["blob:first", "blob:second"]
    let n = 0
    const rendered = render(
      { url: "https://cdn.example/a.jpg" },
      { storage: storageOf(async () => urls[n++]!) }
    )
    await vi.runAllTimersAsync()
    rendered.img()!.dispatchEvent(new Event("load"))
    await vi.runAllTimersAsync()
    expect(rendered.img()?.classList.contains("is-loaded")).toBe(true)

    rendered.url.value = "https://cdn.example/b.jpg"
    await vi.runAllTimersAsync()

    expect(rendered.img()?.getAttribute("src")).toBe("blob:second")
    expect(rendered.img()?.classList.contains("is-loaded")).toBe(false)
  })
})

describe("when the picture will not load", () => {
  it("tries the cache again after the rendered image failed", async () => {
    let n = 0
    const rendered = render(
      { url: "https://cdn.example/cover.jpg" },
      {
        storage: storageOf(async () => {
          n += 1
          return n === 1 ? "blob:broken" : "blob:good"
        }),
      }
    )
    await vi.runAllTimersAsync()
    expect(rendered.img()?.getAttribute("src")).toBe("blob:broken")

    rendered.img()!.dispatchEvent(new Event("error"))
    await vi.runAllTimersAsync()

    expect(rendered.img()?.getAttribute("src")).toBe("blob:good")
  })

  it("serves the cover from another region once this one is out of attempts", async () => {
    const rendered = render(
      { url: "https://cdn.example/cover.jpg" },
      {
        storage: storageOf(async () => {
          throw new Error("cache write failed")
        }),
        failover: async () => "blob:other-region",
      }
    )
    await vi.runAllTimersAsync()
    // Every cached resolve failed, so the raw URL is what is on screen.
    expect(rendered.img()?.getAttribute("src")).toBe("https://cdn.example/cover.jpg")

    rendered.img()!.dispatchEvent(new Event("error"))
    await vi.runAllTimersAsync()

    expect(rendered.img()?.getAttribute("src")).toBe("blob:other-region")
  })

  it("gives up quietly when no region can serve it", async () => {
    const rendered = render(
      { url: "https://cdn.example/cover.jpg" },
      {
        storage: storageOf(async () => {
          throw new Error("cache write failed")
        }),
        failover: async () => null,
      }
    )
    await vi.runAllTimersAsync()

    for (let i = 0; i < 3; i++) {
      rendered.img()!.dispatchEvent(new Event("error"))
      await vi.runAllTimersAsync()
    }

    expect(rendered.img()?.getAttribute("src")).toBe("https://cdn.example/cover.jpg")
  })
})
