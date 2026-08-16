// @vitest-environment jsdom
/**
 * Qase case 570. The app's most-used control shipped as a bare `div` with a
 * click handler (#1887): no role, no accessible name, no way to reach it from
 * a keyboard or a screen reader's control rotor. These assertions pin the
 * element and the three attributes that make it announceable.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type App } from "vue"
import { createI18n } from "vue-i18n"

/* -- Module doubles ---------------------------------------------------- */

vi.mock("vue3-radial-progress", () => ({
  default: defineComponent({ name: "RadialProgress", setup: () => () => h("svg") }),
}))

const { default: FloatingPlayerPlayButton } = await import("../FloatingPlayerPlayButton.vue")

/* -- Harness ----------------------------------------------------------- */

/** Sentinel copy, not the shipped strings: what is under test is that the
 *  label comes out of i18n at all. `localeKeyParity` owns the real bundles. */
const messages = {
  en: { player: { play: "PLAY_EN", pause: "PAUSE_EN", completed: "DONE_EN" } },
}

let app: App | null = null
let host: HTMLElement | null = null

interface Props {
  playing?: boolean
  hidden?: boolean
  position?: number
  duration?: number
  showProgress?: boolean
  size?: number
}

function render(props: Props = {}): HTMLElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(FloatingPlayerPlayButton, {
    playing: false,
    hidden: false,
    position: 0,
    duration: 1000,
    showProgress: false,
    size: 44,
    ...props,
  })
  app.use(createI18n({ legacy: false, locale: "en", messages }))
  app.mount(host)
  return host
}

function control(): HTMLElement {
  const el = host!.querySelector(".play-fixed")
  expect(el).not.toBeNull()
  return el as HTMLElement
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

/* -- Cases ------------------------------------------------------------- */

describe("floating player play button", () => {
  it("is a real button, so the role and the focus come from the element", () => {
    render()

    expect(control().tagName).toBe("BUTTON")
    expect(control().getAttribute("type")).toBe("button")
  })

  it("names itself after what a tap will do", () => {
    render({ playing: false })
    expect(control().getAttribute("aria-label")).toBe("PLAY_EN")

    app!.unmount()
    host!.remove()

    render({ playing: true })
    expect(control().getAttribute("aria-label")).toBe("PAUSE_EN")
  })

  it("announces a finished lecture rather than offering to play it", () => {
    // Same state that makes onClick inert — position has reached duration.
    render({ position: 1000, duration: 1000 })

    expect(control().getAttribute("aria-label")).toBe("DONE_EN")
  })

  it("is reachable by keyboard while the player is on screen", () => {
    render({ hidden: false })

    expect(control().getAttribute("tabindex")).toBe("0")
    expect(control().getAttribute("aria-hidden")).toBe("false")
  })

  it("leaves the tab order with the rest of the hidden player", () => {
    // aria-hidden on a focusable element is the violation this pairs against:
    // a screen-reader user could tab to a control that is not announced.
    render({ hidden: true })

    expect(control().getAttribute("aria-hidden")).toBe("true")
    expect(control().getAttribute("tabindex")).toBe("-1")
  })
})
