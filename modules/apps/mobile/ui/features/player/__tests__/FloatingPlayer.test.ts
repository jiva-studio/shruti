// @vitest-environment jsdom
/**
 * `App.vue` renders the player unconditionally and `.hidden` only drops
 * `opacity` / `pointer-events` — so the hidden shell (title, author, mix
 * slider, speed, skip) has to leave the accessibility tree itself, or it sits
 * in every screen's tree for a user who has never played anything.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type App } from "vue"
import { createI18n } from "vue-i18n"

/* -- Module doubles ---------------------------------------------------- */

const stub = (tag: string, name: string) => defineComponent({ name, setup: () => () => h(tag) })

vi.mock("../MixControl.vue", () => ({ default: stub("mix-control", "MixControl") }))
vi.mock("../PlayerControls.vue", () => ({ default: stub("player-controls", "PlayerControls") }))
vi.mock("../SpeedSkipPanel.vue", () => ({ default: stub("speed-skip", "SpeedSkipPanel") }))
vi.mock("../FloatingPlayerPageDots.vue", () => ({ default: stub("page-dots", "PageDots") }))
vi.mock("../FloatingPlayerPlayButton.vue", () => ({ default: stub("play-button", "PlayButton") }))

const { default: FloatingPlayer } = await import("../FloatingPlayer.vue")

/* -- Harness ----------------------------------------------------------- */

const messages = { en: { player: { mix: { left: "L", right: "R" } } } }

let app: App | null = null
let host: HTMLElement | null = null

function render(hidden: boolean): HTMLElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(FloatingPlayer, {
    playing: false,
    title: "Happiness Beyond The Senses",
    author: "A.C. Bhaktivedanta Swami",
    hidden,
    duration: 1000,
    position: 0,
    showProgress: false,
    sticked: false,
    pulsing: false,
    mixPosition: 0,
    playbackSpeed: 1,
  })
  app.use(createI18n({ legacy: false, locale: "en", messages }))
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

/* -- Cases ------------------------------------------------------------- */

describe("floating player shell", () => {
  it("leaves the accessibility tree while it is hidden", () => {
    const el = render(true).querySelector(".player")

    expect(el?.getAttribute("aria-hidden")).toBe("true")
  })

  it("rejoins it as soon as something is playing", () => {
    const el = render(false).querySelector(".player")

    expect(el?.getAttribute("aria-hidden")).toBe("false")
  })
})
