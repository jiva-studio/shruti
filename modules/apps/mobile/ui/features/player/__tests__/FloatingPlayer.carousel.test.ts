// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue"

/* -- Module doubles ---------------------------------------------------- */

const VIEWPORT_HEIGHT = 58

const PAGE_EVENTS = [
  "update:mixPosition",
  "mix-tick",
  "update:playbackSpeed",
  "speed-tick",
  "skip-back",
  "skip-forward",
]

type PageEvent =
  | "update:mixPosition"
  | "mix-tick"
  | "update:playbackSpeed"
  | "speed-tick"
  | "skip-back"
  | "skip-forward"

vi.mock("../FloatingPlayerPages.vue", () => ({
  default: defineComponent({
    name: "FloatingPlayerPages",
    props: { page: { type: Number, required: true } },
    emits: PAGE_EVENTS,
    setup(props, { emit, expose }) {
      const viewport = ref<HTMLElement | null>(null)
      // The real controls all carry `@click.stop`, so a tap on one of them
      // never reaches the shell's open-fullscreen handler.
      const fire = (name: PageEvent, value?: number) => (e: Event) => {
        e.stopPropagation()
        emit(name, value)
      }
      expose({
        viewportEl: () => {
          const el = viewport.value
          if (el) el.getBoundingClientRect = () => new DOMRect(0, 0, 200, VIEWPORT_HEIGHT)
          return el
        },
      })
      return () =>
        h("pages", { ref: viewport, "data-page": String(props.page) }, [
          h("button", { class: "mix", onClick: fire("update:mixPosition", -0.5) }),
          h("button", { class: "mix-tick", onClick: fire("mix-tick") }),
          h("button", { class: "speed", onClick: fire("update:playbackSpeed", 1.5) }),
          h("button", { class: "speed-tick", onClick: fire("speed-tick") }),
          h("button", { class: "skip-back", onClick: fire("skip-back") }),
          h("button", { class: "skip-forward", onClick: fire("skip-forward") }),
        ])
    },
  }),
}))

vi.mock("../FloatingPlayerPageDots.vue", () => ({
  default: defineComponent({
    name: "FloatingPlayerPageDots",
    props: { page: { type: Number, required: true }, count: { type: Number, required: true } },
    setup: (props) => () => h("page-dots", `${props.page}/${props.count}`),
  }),
}))

vi.mock("../FloatingPlayerPlayButton.vue", () => ({
  default: defineComponent({
    name: "FloatingPlayerPlayButton",
    props: { size: { type: Number, required: true } },
    emits: ["play"],
    setup:
      (props, { emit }) =>
      () =>
        h("button", {
          class: "play",
          "data-size": String(props.size),
          onClick: (e: Event) => {
            e.stopPropagation()
            emit("play")
          },
        }),
  }),
}))

const { default: FloatingPlayer } = await import("../FloatingPlayer.vue")

type PlayerProps = InstanceType<typeof FloatingPlayer>["$props"]

/* -- Harness ----------------------------------------------------------- */

let app: App | null = null

interface Rendered {
  readonly host: HTMLElement
  readonly shell: HTMLElement
  readonly events: string[]
}

function render(over: Partial<PlayerProps> = {}): Rendered {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const events: string[] = []
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      events.push(args.length > 0 ? `${name}:${String(args[0])}` : name)

  app = createApp(
    defineComponent({
      setup: () => () =>
        h(FloatingPlayer, {
          playing: false,
          title: "Happiness Beyond The Senses",
          author: "A.C. Bhaktivedanta Swami",
          hidden: false,
          duration: 1000,
          position: 0,
          showProgress: false,
          sticked: false,
          pulsing: false,
          mixPosition: 0,
          playbackSpeed: 1,
          ...over,
          onClick: record("click"),
          "onPlay-clicked": record("play-clicked"),
          "onUpdate:mixPosition": record("mix"),
          "onMix-tick": record("mix-tick"),
          "onUpdate:playbackSpeed": record("speed"),
          "onSpeed-tick": record("speed-tick"),
          "onSkip-back": record("skip-back"),
          "onSkip-forward": record("skip-forward"),
        }),
    })
  )
  app.mount(host)
  return { host, shell: host.querySelector(".player") as HTMLElement, events }
}

/** jsdom ships no PointerEvent, and the carousel only reads these four fields. */
function pointer(type: string, x: number, y: number, pointerId = 1): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: x },
    clientY: { value: y },
  })
  return event
}

function swipe(shell: HTMLElement, from: number, to: number): void {
  shell.dispatchEvent(pointer("pointerdown", 100, from))
  window.dispatchEvent(pointer("pointermove", 100, to))
  window.dispatchEvent(pointer("pointerup", 100, to))
}

const page = (host: HTMLElement): string => host.querySelector("page-dots")?.textContent ?? ""

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
})

/* -- Cases ------------------------------------------------------------- */

describe("floating player, tapping the shell", () => {
  it("opens the fullscreen view", () => {
    const { shell, events } = render()
    shell.click()
    expect(events).toEqual(["click"])
  })

  it("does not open it on the tap synthesised after a page swipe", () => {
    const { shell, events } = render()
    swipe(shell, 40, 5)
    shell.click()
    expect(events).toEqual([])
  })

  it("opens it again on the next real tap", () => {
    const { shell, events } = render()
    swipe(shell, 40, 5)
    shell.click()
    shell.click()
    expect(events).toEqual(["click"])
  })

  it("still opens it after a horizontal drag, which belongs to the sliders", () => {
    const { shell, events } = render()
    shell.dispatchEvent(pointer("pointerdown", 100, 40))
    window.dispatchEvent(pointer("pointermove", 160, 40))
    window.dispatchEvent(pointer("pointerup", 160, 40))
    shell.click()
    expect(events).toEqual(["click"])
  })
})

describe("floating player, swiping between pages", () => {
  it("starts on the title page", () => {
    const { host } = render()
    expect(page(host)).toBe("1/3")
  })

  it("reveals the speed page on a swipe up", async () => {
    const { host, shell } = render()
    swipe(shell, 40, 5)
    await nextTick()
    expect(page(host)).toBe("2/3")
    expect(host.querySelector("pages")?.getAttribute("data-page")).toBe("2")
  })

  it("reveals the mix page on a swipe down", async () => {
    const { host, shell } = render()
    swipe(shell, 5, 40)
    await nextTick()
    expect(page(host)).toBe("0/3")
  })

  it("stays put when the drag is too short to commit a page", async () => {
    const { host, shell } = render()
    swipe(shell, 40, 28)
    await nextTick()
    expect(page(host)).toBe("1/3")
  })

  it("ignores swipes while the player is hidden", async () => {
    const { host, shell } = render({ hidden: true })
    swipe(shell, 40, 5)
    await nextTick()
    expect(page(host)).toBe("1/3")
  })
})

describe("floating player, forwarding its controls", () => {
  it("passes the play button's tap to the owner", () => {
    const { host, events } = render()
    host.querySelector<HTMLElement>(".play")!.click()
    expect(events).toEqual(["play-clicked"])
  })

  it("passes every carousel control to the owner", () => {
    const { host, events } = render()
    for (const cls of ["mix", "mix-tick", "speed", "speed-tick", "skip-back", "skip-forward"]) {
      host.querySelector<HTMLElement>(`.${cls}`)!.click()
    }
    expect(events).toEqual([
      "mix:-0.5",
      "mix-tick",
      "speed:1.5",
      "speed-tick",
      "skip-back",
      "skip-forward",
    ])
  })
})

describe("floating player, its shell", () => {
  it("sizes the play button and the space reserved for it together", () => {
    const { host, shell } = render({ playButtonSize: 60 })
    expect(shell.style.getPropertyValue("--play-button-size")).toBe("60px")
    expect(host.querySelector(".play")?.getAttribute("data-size")).toBe("60")
  })

  it("docks to the bottom edge when sticked", () => {
    const { shell } = render({ sticked: true })
    expect(shell.classList.contains("stick")).toBe(true)
    expect(shell.classList.contains("floating")).toBe(false)
  })

  it("floats above the tab bar otherwise", () => {
    const { shell } = render()
    expect(shell.classList.contains("floating")).toBe(true)
  })

  it("pulses only when invited to", () => {
    expect(render({ pulsing: true }).shell.classList.contains("pulsing")).toBe(true)
    app?.unmount()
    document.body.innerHTML = ""
    expect(render().shell.classList.contains("pulsing")).toBe(false)
  })
})
