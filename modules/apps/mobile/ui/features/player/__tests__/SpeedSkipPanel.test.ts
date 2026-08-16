// @vitest-environment jsdom
/**
 * Qase case 572. Both skip buttons carried a hardcoded English `aria-label`
 * in an app that ships fourteen locales (#1887), so a Russian or Hindi
 * screen-reader user heard English. The bundles themselves are asserted by
 * `localeKeyParity` / `translationKeys`; what this pins is that the component
 * reads them at all, and interpolates the seek amount it actually performs.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type App } from "vue"
import { createI18n } from "vue-i18n"

/* -- Module doubles ---------------------------------------------------- */

const stub = (tag: string, name: string) => defineComponent({ name, setup: () => () => h(tag) })

vi.mock("@ionic/vue", () => ({ IonRippleEffect: stub("ion-ripple-effect", "IonRippleEffect") }))
vi.mock("../SpeedSlider.vue", () => ({ default: stub("speed-slider", "SpeedSlider") }))

const { default: SpeedSkipPanel } = await import("../SpeedSkipPanel.vue")

/* -- Harness ----------------------------------------------------------- */

/** Sentinel copy in two locales — the point is that the label follows the
 *  active locale, not that these particular words are right. */
const messages = {
  en: { player: { skip: { back: "BACK {seconds}", forward: "FWD {seconds}" } } },
  ru: { player: { skip: { back: "НАЗАД {seconds}", forward: "ВПЕРЁД {seconds}" } } },
}

let app: App | null = null
let host: HTMLElement | null = null

function render(locale: "en" | "ru" = "en"): HTMLElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(SpeedSkipPanel, { modelValue: 1 })
  app.use(createI18n({ legacy: false, locale, fallbackLocale: [], messages }))
  app.mount(host)
  return host
}

function labels(): (string | null)[] {
  return [...host!.querySelectorAll("button.skip")].map((el) => el.getAttribute("aria-label"))
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

/* -- Cases ------------------------------------------------------------- */

describe("speed / skip panel", () => {
  it("names both skip buttons from the active locale", () => {
    render("ru")

    expect(labels()).toEqual(["НАЗАД 15", "ВПЕРЁД 15"])
  })

  it("follows a different locale rather than staying English", () => {
    render("en")

    expect(labels()).toEqual(["BACK 15", "FWD 15"])
  })

  it("keeps the ripple's clip off the button, so the hit area can grow past it", () => {
    // `overflow: hidden` on the button would clip the hit-area pseudo-element
    // out of hit testing as well as out of painting — the ripple gets its own
    // clipping surface instead. Structural assertion: the ripple is inside the
    // surface span, and `ion-activatable` stays on the button Ionic walks up to.
    render()

    const button = host!.querySelector("button.skip")!
    expect(button.classList.contains("ion-activatable")).toBe(true)
    expect(button.querySelector(".skip-surface > ion-ripple-effect")).not.toBeNull()
  })
})
