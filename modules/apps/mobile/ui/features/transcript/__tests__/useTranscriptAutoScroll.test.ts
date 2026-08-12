// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"
import { useTranscriptAutoScroll } from "../useTranscriptAutoScroll.js"

/**
 * Issue #1741 (9): `isAdjacentBlock` compared `prev.nextElementSibling` with
 * the new active block, but `TranscriptText` renders `<h2 class="chapter-
 * heading">` as a SIBLING between two paragraphs. Crossing a chapter start was
 * therefore classified as a seek and scrolled unconditionally, bypassing both
 * engagement checks — a reader who had scrolled ahead got yanked back to the
 * playhead at every chapter.
 */

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

/** `p1 · <h2> · p2 · p3` — one chapter heading between the first two blocks. */
function buildTranscript(): {
  host: HTMLElement
  scrollTo: ReturnType<typeof vi.fn>
  blocks: HTMLElement[]
} {
  document.body.innerHTML = `
    <div id="host">
      <div class="inner-scroll">
        <div class="transcript-text">
          <p class="prompter paragraph" id="p1">first</p>
          <h2 class="chapter-heading">Chapter two</h2>
          <p class="prompter" id="p2">second</p>
          <p class="prompter" id="p3">third</p>
        </div>
      </div>
    </div>`
  const host = document.getElementById("host")!
  const inner = host.querySelector(".inner-scroll") as HTMLElement
  const scrollTo = vi.fn()
  inner.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"]
  // A 600px viewport with the active block sitting comfortably inside it: in
  // view (so the user is engaged) and well above the bottom comfort band (so a
  // natural block-to-block advance must NOT scroll).
  stubRect(inner, { top: 0, bottom: 600, height: 600 })
  const blocks = [...host.querySelectorAll<HTMLElement>("p.prompter")]
  for (const b of blocks) stubRect(b, { top: 100, bottom: 200, height: 100 })
  return { host, scrollTo, blocks }
}

function makeActive(blocks: HTMLElement[], id: string): void {
  for (const b of blocks) b.classList.toggle("paragraph", b.id === id)
}

/** Let the watcher's `await nextTick()` and the cold-open frames run out, and
 *  clear the smooth-scroll throttle before the next step. */
async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS + 50))
  await nextTick()
}

describe("useTranscriptAutoScroll — chapter headings are not seeks", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  async function mount(): Promise<{
    position: ReturnType<typeof ref<number>>
    scrollTo: ReturnType<typeof vi.fn>
    blocks: HTMLElement[]
  }> {
    const { host, scrollTo, blocks } = buildTranscript()
    const position = ref(10_000)
    const scope = effectScope()
    const api = scope.run(() =>
      useTranscriptAutoScroll({
        contentRef: ref({ $el: host }),
        open: ref(true),
        position: () => position.value as number,
        autoScroll: () => true,
      })
    )!
    await api.onModalPresented()
    await settle()
    scrollTo.mockClear()
    return { position, scrollTo, blocks }
  }

  it("does not yank the reader back when playback crosses a chapter start", async () => {
    const { position, scrollTo, blocks } = await mount()

    // Natural advance p1 → p2, with the chapter `<h2>` sitting between them.
    makeActive(blocks, "p2")
    position.value = 20_000
    await settle()

    // The active block is on screen and nowhere near the bottom band, so the
    // engagement model says "leave the reader alone". Only a seek overrides it.
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("still treats a real jump as a seek", async () => {
    const { position, scrollTo, blocks } = await mount()

    // p1 → p3: two blocks apart, nothing adjacent about it.
    makeActive(blocks, "p3")
    position.value = 40_000
    await settle()

    expect(scrollTo).toHaveBeenCalledOnce()
  })

  it("still follows a natural advance that has drifted past the bottom band", async () => {
    const { position, scrollTo, blocks } = await mount()

    // Same chapter-crossing advance, but now the active block has drifted to
    // the very bottom of the viewport — the one case the model does scroll.
    stubRect(blocks[1], { top: 560, bottom: 590, height: 30 })
    makeActive(blocks, "p2")
    position.value = 20_000
    await settle()

    expect(scrollTo).toHaveBeenCalledOnce()
  })
})
