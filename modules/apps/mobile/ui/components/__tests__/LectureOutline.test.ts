// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { createApp, type App } from "vue"
import LectureOutline from "../LectureOutline.vue"
import type { UiOutlineChapter } from "../types.js"

let app: App | null = null
let host: HTMLElement | null = null

function render(props: {
  chapters: readonly UiOutlineChapter[]
  interactive?: boolean
  onSeek?: (startMs: number) => void
}): HTMLElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(LectureOutline, {
    chapters: props.chapters,
    interactive: props.interactive,
    onSeek: props.onSeek,
  })
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe("LectureOutline component", () => {
  const subHourChapters: UiOutlineChapter[] = [
    { title: "Introduction", startMs: 0, endMs: 300_000 },
    { title: "Main topic", startMs: 300_000, endMs: 720_000 },
    { title: "Discussion", startMs: 720_000, endMs: 1_500_000 },
    { title: "Conclusion", startMs: 1_500_000, endMs: 2_100_000 },
  ]

  const hourPlusChapters: UiOutlineChapter[] = [
    { title: "Opening", startMs: 0, endMs: 600_000 },
    { title: "Part 1", startMs: 600_000, endMs: 3_600_000 },
    { title: "Part 2", startMs: 3_600_000, endMs: 4_500_000 },
    { title: "Q&A", startMs: 4_500_000, endMs: 5_400_000 },
  ]

  it("renders chapter titles and timestamps formatted as MM:SS for lectures under 1 hour", () => {
    const el = render({ chapters: subHourChapters })
    const items = el.querySelectorAll("li.chapter")
    expect(items).toHaveLength(4)

    const times = Array.from(el.querySelectorAll(".time")).map((t) => t.textContent?.trim())
    const titles = Array.from(el.querySelectorAll(".chapter-title")).map((t) =>
      t.textContent?.trim()
    )

    expect(times).toEqual(["00:00", "05:00", "12:00", "25:00"])
    expect(titles).toEqual(["Introduction", "Main topic", "Discussion", "Conclusion"])
  })

  it("renders chapter timestamps formatted with hours (H:MM:SS) when any chapter exceeds 1 hour", () => {
    const el = render({ chapters: hourPlusChapters })
    const times = Array.from(el.querySelectorAll(".time")).map((t) => t.textContent?.trim())

    expect(times).toEqual(["0:00:00", "0:10:00", "1:00:00", "1:15:00"])
  })

  it("emits seek event on chapter click when interactive is true", () => {
    const seeks: number[] = []
    const el = render({
      chapters: subHourChapters,
      interactive: true,
      onSeek: (ms) => seeks.push(ms),
    })

    const items = el.querySelectorAll("li.chapter")
    expect(items[0].classList.contains("interactive")).toBe(true)
    ;(items[1] as HTMLElement).click()
    ;(items[2] as HTMLElement).click()

    expect(seeks).toEqual([300_000, 720_000])
  })

  it("does not emit seek event on chapter click when interactive is false", () => {
    const seeks: number[] = []
    const el = render({
      chapters: subHourChapters,
      interactive: false,
      onSeek: (ms) => seeks.push(ms),
    })

    const items = el.querySelectorAll("li.chapter")
    expect(items[0].classList.contains("interactive")).toBe(false)
    ;(items[1] as HTMLElement).click()

    expect(seeks).toEqual([])
  })
})
