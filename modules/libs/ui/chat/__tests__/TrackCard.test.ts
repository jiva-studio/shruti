// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h, type Slots } from "vue"
import TrackCard from "../TrackCard.vue"
import ExcerptPlayer from "../ExcerptPlayer.vue"

interface Mounted {
  host: HTMLElement
  activations: number
}

type TrackCardProps = Omit<InstanceType<typeof TrackCard>["$props"], "onActivate">
type ExcerptPlayerProps = Omit<InstanceType<typeof ExcerptPlayer>["$props"], "onToggle" | "onSeek">

function mount(props: TrackCardProps, slots: Slots = {}): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const m: Mounted = { host, activations: 0 }
  createApp({
    render: () => h(TrackCard, { ...props, onActivate: () => (m.activations += 1) }, slots),
  }).mount(host)
  return m
}

describe("TrackCard", () => {
  it("shows the lecture title", () => {
    const m = mount({ title: "Morning Walk" })

    expect(m.host.querySelector(".title")!.textContent).toBe("Morning Walk")
  })

  it("shows the reference, the count of the rest and the meta line", () => {
    const m = mount({
      title: "Morning Walk",
      primaryRef: "BG 2.20",
      extraRefCount: 3,
      metaLine: "Vrindavan, 1974",
    })

    expect(m.host.querySelector(".ref")!.textContent).toBe("BG 2.20")
    expect(m.host.querySelector(".ref.extra")!.textContent).toBe("+3")
    expect(m.host.querySelector(".details")!.textContent).toBe("Vrindavan, 1974")
  })

  it("leaves out the details line for a lecture with no references or meta", () => {
    const m = mount({ title: "Morning Walk" })

    expect(m.host.querySelector(".details-line")).toBeNull()
  })

  it("says so when the lecture could not be resolved", () => {
    const m = mount({ title: "Morning Walk", error: true, missingLabel: "Lecture unavailable" })

    expect(m.host.querySelector(".placeholder.error")!.textContent).toBe("Lecture unavailable")
    expect(m.host.querySelector(".title")).toBeNull()
  })

  it("opens on a tap and on the keyboard", () => {
    const m = mount({ title: "Morning Walk" })
    const card = m.host.querySelector<HTMLElement>(".lecture-card")!

    card.click()
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))

    expect(m.activations).toBe(2)
  })

  it("lets the host bring its own icon", () => {
    const m = mount({ title: "Morning Walk" }, { icon: () => [h("i", { class: "own-icon" })] })

    expect(m.host.querySelector(".own-icon")).not.toBeNull()
    expect(m.host.querySelector(".lecture-icon svg")).toBeNull()
  })
})

describe("ExcerptPlayer", () => {
  interface Player {
    host: HTMLElement
    toggles: number
    seeks: number
  }

  function mountPlayer(props: ExcerptPlayerProps, slots: Slots = {}): Player {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const p: Player = { host, toggles: 0, seeks: 0 }
    createApp({
      render: () =>
        h(
          ExcerptPlayer,
          { ...props, onToggle: () => (p.toggles += 1), onSeek: () => (p.seeks += 1) },
          slots
        ),
    }).mount(host)
    return p
  }

  const base = { peaks: [10, 50, 90], progressFraction: 0, isPlaying: false, isPreparing: false }

  it("draws the waveform it was handed", () => {
    const p = mountPlayer(base)

    expect([...p.host.querySelectorAll<HTMLElement>(".bar")].map((b) => b.style.height)).toEqual([
      "10%",
      "50%",
      "90%",
    ])
  })

  it("offers Play while paused and Pause while playing", () => {
    const paused = mountPlayer(base)
    const playing = mountPlayer({ ...base, isPlaying: true })

    expect(paused.host.querySelector(".play-btn")!.getAttribute("aria-label")).toBe("Play")
    expect(playing.host.querySelector(".play-btn")!.getAttribute("aria-label")).toBe("Pause")
  })

  it("shows the host's spinner and refuses taps while buffering", () => {
    const p = mountPlayer(
      { ...base, isPreparing: true },
      { spinner: () => [h("i", { class: "d" })] }
    )
    const btn = p.host.querySelector<HTMLButtonElement>(".play-btn")!

    expect(btn.disabled).toBe(true)
    expect(btn.querySelector(".d")).not.toBeNull()

    btn.click()

    expect(p.toggles).toBe(0)
  })

  it("asks the host to toggle and to seek", () => {
    const p = mountPlayer(base)

    p.host.querySelector<HTMLButtonElement>(".play-btn")!.click()
    p.host.querySelector<HTMLElement>(".waveform")!.click()

    expect(p.toggles).toBe(1)
    expect(p.seeks).toBe(1)
  })

  it("colours the bars behind the playhead", () => {
    const p = mountPlayer({ ...base, progressFraction: 0.5 })

    expect(
      [...p.host.querySelectorAll(".bar")].map((b) => b.classList.contains("is-played"))
    ).toEqual([true, true, false])
  })
})
