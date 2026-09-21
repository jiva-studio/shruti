// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { effectScope, nextTick, ref, type Ref } from "vue"
import { useTranscriptAutoScroll } from "../useTranscriptAutoScroll.js"

/** Smooth-scroll throttle inside the composable; steps must clear it. */
const THROTTLE_MS = 400

interface Rect {
  readonly top: number
  readonly bottom: number
  readonly height: number
}

function stubRect(el: Element, rect: Rect): void {
  el.getBoundingClientRect = () =>
    ({ ...rect, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}

interface Transcript {
  readonly host: HTMLElement
  readonly inner: HTMLElement
  readonly scrollTo: ReturnType<typeof vi.fn>
  readonly blocks: HTMLElement[]
}

/** Three blocks in one scroller, the first one active. Each block sits at the
 *  very bottom of the viewport, so a reader following along is engaged and any
 *  advance is worth a scroll — what is under test here is the machinery, not
 *  the engagement model. */
function buildTranscript(): Transcript {
  document.body.innerHTML = `
    <div id="host">
      <div class="inner-scroll">
        <div class="transcript-text">
          <p class="prompter paragraph" id="p1">first</p>
          <p class="prompter" id="p2">second</p>
          <p class="prompter" id="p3">third</p>
        </div>
      </div>
    </div>`
  const host = document.getElementById("host")!
  const inner = host.querySelector(".inner-scroll") as HTMLElement
  const scrollTo = vi.fn()
  inner.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"]
  stubRect(inner, { top: 0, bottom: 600, height: 600 })
  const blocks = [...host.querySelectorAll<HTMLElement>("p.prompter")]
  for (const b of blocks) stubRect(b, { top: 500, bottom: 590, height: 90 })
  return { host, inner, scrollTo, blocks }
}

function makeActive(blocks: HTMLElement[], id: string): void {
  for (const b of blocks) b.classList.toggle("paragraph", b.id === id)
}

async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS + 50))
  await nextTick()
}

interface Harness extends Transcript {
  readonly position: Ref<number>
  readonly open: Ref<boolean>
  readonly autoScroll: Ref<boolean>
  readonly present: () => Promise<void>
}

function mount(opts: { autoScroll?: boolean; useGetScrollElement?: boolean } = {}): Harness {
  const transcript = buildTranscript()
  const position = ref(10_000)
  const open = ref(true)
  const autoScroll = ref(opts.autoScroll ?? true)

  const contentEl = transcript.host as HTMLElement & {
    getScrollElement?: () => Promise<HTMLElement>
  }
  if (opts.useGetScrollElement) {
    contentEl.getScrollElement = async () => transcript.inner
  }

  const scope = effectScope()
  const api = scope.run(() =>
    useTranscriptAutoScroll({
      contentRef: ref({ $el: transcript.host }),
      open,
      position: () => position.value,
      autoScroll: () => autoScroll.value,
    })
  )!

  return { ...transcript, position, open, autoScroll, present: api.onModalPresented }
}

describe("attaching to the dialog", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("snaps to the playing block when the dialog opens", async () => {
    const h = mount()
    await h.present()
    await settle()
    expect(h.scrollTo).toHaveBeenCalledWith({ top: 440, behavior: "smooth" })
  })

  it("scrolls the element ion-content hands over, not the host", async () => {
    const h = mount({ useGetScrollElement: true })
    const hostScroll = vi.fn()
    h.host.scrollTo = hostScroll as unknown as HTMLElement["scrollTo"]

    await h.present()
    await settle()

    expect(h.scrollTo).toHaveBeenCalledOnce()
    expect(hostScroll).not.toHaveBeenCalled()
  })

  it("does nothing at all while the Pro toggle is off", async () => {
    const h = mount({ autoScroll: false })
    await h.present()
    await settle()

    makeActive(h.blocks, "p2")
    h.position.value = 20_000
    await settle()

    expect(h.scrollTo).not.toHaveBeenCalled()
  })

  it("leaves the viewport alone when no block is playing yet", async () => {
    const h = mount()
    for (const b of h.blocks) b.classList.remove("paragraph")

    await h.present()
    await settle()

    expect(h.scrollTo).not.toHaveBeenCalled()
  })
})

describe("following playback", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("moves to each new block as it becomes active", async () => {
    const h = mount()
    await h.present()
    await settle()
    h.scrollTo.mockClear()

    makeActive(h.blocks, "p2")
    h.position.value = 20_000
    await settle()

    expect(h.scrollTo).toHaveBeenCalledOnce()
  })

  it("ignores the near-zero position a seek emits on its way to the target", async () => {
    const h = mount()
    await h.present()
    h.position.value = 11_000
    await settle()
    h.scrollTo.mockClear()

    // The seek's first emit drops the playhead to ~0 and flips the active
    // block to the first one; the real target arrives on the next emit.
    makeActive(h.blocks, "p2")
    h.position.value = 100
    await settle()

    expect(h.scrollTo).not.toHaveBeenCalled()
  })

  it("stays put while the block under the playhead has not changed", async () => {
    const h = mount()
    await h.present()
    await settle()
    h.scrollTo.mockClear()

    h.position.value = 11_000
    await settle()

    expect(h.scrollTo).not.toHaveBeenCalled()
  })
})

describe("closing and re-enabling", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("stops following once the dialog is closed", async () => {
    const h = mount()
    await h.present()
    await settle()
    h.scrollTo.mockClear()

    h.open.value = false
    await nextTick()
    makeActive(h.blocks, "p2")
    h.position.value = 20_000
    await settle()

    expect(h.scrollTo).not.toHaveBeenCalled()
  })

  it("stops following when the toggle goes off mid-session", async () => {
    const h = mount()
    await h.present()
    await settle()
    h.scrollTo.mockClear()

    h.autoScroll.value = false
    await nextTick()
    makeActive(h.blocks, "p2")
    h.position.value = 20_000
    await settle()

    expect(h.scrollTo).not.toHaveBeenCalled()
  })

  it("follows again from the next block when the toggle comes back on", async () => {
    const h = mount({ autoScroll: false })
    await h.present()
    await settle()

    h.autoScroll.value = true
    await settle()
    // Turning it on is not itself a reason to move the reader.
    expect(h.scrollTo).not.toHaveBeenCalled()

    makeActive(h.blocks, "p2")
    h.position.value = 20_000
    await settle()

    expect(h.scrollTo).toHaveBeenCalledOnce()
  })

  it("does not re-arm from a toggle flipped after the dialog closed", async () => {
    const h = mount()
    await h.present()
    await settle()
    h.scrollTo.mockClear()

    h.open.value = false
    await nextTick()
    h.autoScroll.value = false
    h.autoScroll.value = true
    await settle()

    makeActive(h.blocks, "p2")
    h.position.value = 20_000
    await settle()

    expect(h.scrollTo).not.toHaveBeenCalled()
  })
})

describe("coming back to the tab", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  /** Two frames, which is what the focus handler waits for. */
  async function frames(): Promise<void> {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    await nextTick()
  }

  it("re-snaps to the playing block after the focus trap moved the viewport", async () => {
    const h = mount()
    await h.present()
    await settle()
    h.scrollTo.mockClear()

    window.dispatchEvent(new Event("focus"))
    await frames()

    // Immediately, without waiting out the smooth-scroll throttle: the
    // viewport is wrong right now.
    expect(h.scrollTo).toHaveBeenCalledWith({ top: 440, behavior: "smooth" })
  })

  it("leaves the viewport alone when the toggle is off", async () => {
    const h = mount()
    await h.present()
    await settle()
    h.scrollTo.mockClear()

    h.autoScroll.value = false
    await nextTick()
    window.dispatchEvent(new Event("focus"))
    await frames()

    expect(h.scrollTo).not.toHaveBeenCalled()
  })

  it("is deaf to focus once the dialog has closed", async () => {
    const h = mount()
    await h.present()
    await settle()
    h.scrollTo.mockClear()

    h.open.value = false
    await nextTick()
    window.dispatchEvent(new Event("focus"))
    await frames()

    expect(h.scrollTo).not.toHaveBeenCalled()
  })
})
