// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { createApp, h, nextTick, reactive, type Slots } from "vue"
import AudioPlayerBar from "../AudioPlayerBar.vue"

interface Props {
  playing: boolean
  positionMs: number
  durationMs: number
  speed: number
  speeds?: number[]
  title?: string
  subtitle?: string
  busy?: boolean
}

interface Mounted {
  host: HTMLElement
  props: Props
  toggles: number
  seeks: number[]
  speeds: number[]
}

function mount(props: Props, slots: Slots = {}): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive(props)
  const m: Mounted = { host, props: state, toggles: 0, seeks: [], speeds: [] }
  createApp({
    render: () =>
      h(
        AudioPlayerBar,
        {
          ...state,
          onToggle: () => (m.toggles += 1),
          onSeek: (ms: number) => m.seeks.push(ms),
          "onUpdate:speed": (v: number) => m.speeds.push(v),
        },
        slots
      ),
  }).mount(host)
  return m
}

/** jsdom lays nothing out, so the seek strip is given a geometry by hand. */
beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return { left: 50, width: 200, top: 0, height: 18, right: 250, bottom: 18 } as DOMRect
  }
  HTMLElement.prototype.setPointerCapture = function (): void {}
})

function pointerDown(el: HTMLElement, clientX: number): void {
  el.dispatchEvent(
    new MouseEvent("pointerdown", { clientX, bubbles: true }) as unknown as PointerEvent
  )
}

function pointerAt(el: HTMLElement, type: string, clientX: number): void {
  el.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }))
}

const base: Props = { playing: false, positionMs: 0, durationMs: 60_000, speed: 1 }

describe("AudioPlayerBar — transport", () => {
  it("offers Play while paused and Pause while playing", async () => {
    const m = mount({ ...base })
    const btn = m.host.querySelector<HTMLButtonElement>(".play-btn")!

    expect(btn.getAttribute("aria-label")).toBe("Play")

    m.props.playing = true
    await nextTick()

    expect(btn.getAttribute("aria-label")).toBe("Pause")
  })

  it("asks the host to toggle on a tap", () => {
    const m = mount({ ...base })

    m.host.querySelector<HTMLButtonElement>(".play-btn")!.click()

    expect(m.toggles).toBe(1)
  })

  it("shows the spinner and refuses taps while busy", () => {
    const m = mount({ ...base, busy: true }, { spinner: () => [h("i", { class: "dots" })] })
    const btn = m.host.querySelector<HTMLButtonElement>(".play-btn")!

    expect(btn.disabled).toBe(true)
    expect(btn.querySelector(".dots")).not.toBeNull()
    expect(btn.querySelector("svg")).toBeNull()

    btn.click()

    expect(m.toggles).toBe(0)
  })
})

describe("AudioPlayerBar — progress", () => {
  it("fills the strip in proportion to the position", async () => {
    const m = mount({ ...base, positionMs: 15_000 })

    expect(m.host.querySelector<HTMLElement>(".seek-fill")!.style.width).toBe("25%")
    expect(m.host.querySelector<HTMLElement>(".seek-thumb")!.style.left).toBe("25%")

    m.props.positionMs = 45_000
    await nextTick()

    expect(m.host.querySelector<HTMLElement>(".seek-fill")!.style.width).toBe("75%")
  })

  it("stays empty while the duration is unknown", () => {
    const m = mount({ ...base, durationMs: 0, positionMs: 5_000 })

    expect(m.host.querySelector<HTMLElement>(".seek-fill")!.style.width).toBe("0%")
  })

  it("never overfills on a position past the end", () => {
    const m = mount({ ...base, positionMs: 999_999 })

    expect(m.host.querySelector<HTMLElement>(".seek-fill")!.style.width).toBe("100%")
  })

  it("publishes the position to assistive tech", () => {
    const m = mount({ ...base, positionMs: 15_000 })
    const slider = m.host.querySelector(".seek-track")!

    expect(slider.getAttribute("role")).toBe("slider")
    expect(slider.getAttribute("aria-valuemax")).toBe("60000")
    expect(slider.getAttribute("aria-valuenow")).toBe("15000")
  })
})

describe("AudioPlayerBar — seeking", () => {
  it("seeks to the point that was pressed", () => {
    const m = mount({ ...base })

    pointerDown(m.host.querySelector<HTMLElement>(".seek-track")!, 100)

    expect(m.seeks).toEqual([15_000])
  })

  it("keeps seeking while the finger drags, and stops when it lifts", () => {
    const m = mount({ ...base })
    const track = m.host.querySelector<HTMLElement>(".seek-track")!

    pointerDown(track, 50)
    pointerAt(track, "pointermove", 150)
    pointerAt(track, "pointerup", 150)
    pointerAt(track, "pointermove", 250)

    expect(m.seeks).toEqual([0, 30_000])
  })

  it("stops seeking when the gesture is cancelled", () => {
    const m = mount({ ...base })
    const track = m.host.querySelector<HTMLElement>(".seek-track")!

    pointerDown(track, 100)
    pointerAt(track, "pointercancel", 100)
    pointerAt(track, "pointermove", 250)

    expect(m.seeks).toEqual([15_000])
  })

  it("clamps a drag past either end", () => {
    const m = mount({ ...base })
    const track = m.host.querySelector<HTMLElement>(".seek-track")!

    pointerDown(track, -500)
    pointerAt(track, "pointermove", 5000)

    expect(m.seeks).toEqual([0, 60_000])
  })

  it("ignores a press on a strip of unknown length", () => {
    const m = mount({ ...base, durationMs: 0 })

    pointerDown(m.host.querySelector<HTMLElement>(".seek-track")!, 100)

    expect(m.seeks).toEqual([])
  })
})

describe("AudioPlayerBar — speed", () => {
  it("lists the speeds with a multiplication sign", () => {
    const m = mount({ ...base })

    expect([...m.host.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "×0.75",
      "×1",
      "×1.25",
      "×1.5",
      "×1.75",
      "×2",
    ])
  })

  it("takes the speeds the host supplies", () => {
    const m = mount({ ...base, speeds: [1, 3] })

    expect([...m.host.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["×1", "×3"])
  })

  it("reports a picked speed as a number, not the option string", () => {
    const m = mount({ ...base })
    const select = m.host.querySelector<HTMLSelectElement>(".speed-select")!

    select.value = "1.5"
    select.dispatchEvent(new Event("change"))

    expect(m.speeds).toEqual([1.5])
  })

  it("shows the speed the host is actually playing at", () => {
    const m = mount({ ...base, speed: 1.75 })

    expect(m.host.querySelector<HTMLSelectElement>(".speed-select")!.value).toBe("1.75")
  })
})

describe("AudioPlayerBar — chrome", () => {
  it("shows the title and subtitle when given", () => {
    const m = mount({ ...base, title: "BG 2.13", subtitle: "Vrindavan, 1974" })

    expect(m.host.querySelector(".player-title")!.textContent).toBe("BG 2.13")
    expect(m.host.querySelector(".player-subtitle")!.textContent).toBe("Vrindavan, 1974")
  })

  it("leaves out the meta row when there is nothing to say", () => {
    const m = mount({ ...base })

    expect(m.host.querySelector(".player-meta")).toBeNull()
  })

  it("hands the centre over to a waveform slot instead of the strip", () => {
    const m = mount({ ...base }, { waveform: () => [h("div", { class: "peaks" })] })

    expect(m.host.querySelector(".peaks")).not.toBeNull()
    expect(m.host.querySelector(".seek-track")).toBeNull()
  })
})
