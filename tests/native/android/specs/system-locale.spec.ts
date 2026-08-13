import { world } from "../src/world.js"

/**
 * The UI language is decided at boot, from the locale the OS hands the WebView
 * (`navigator.language`), so this has to survive a restart — a live
 * configuration change alone would not move it.
 *
 * The lever is LocaleManager's per-app locale, the setting Android's own "App
 * language" screen writes. The device-wide one is out of reach from a test:
 * `persist.sys.locale` is read once, when the framework boots, so changing it
 * needs root and `stop; start` — which takes this session, and everyone else
 * on the emulator, down with it.
 */
describe("system locale", () => {
  const { app, language, screens } = world()
  let english = ""

  before(async () => {
    // Onboarding is deliberately left up: its call to action is the localized
    // copy the assertion reads, and it survives a restart until it is finished.
    english = await screens.onboarding.primaryLabel()
  })

  after(async () => {
    await language.clear()
  })

  it("renders in the language the OS gives the app", async () => {
    await language.set("ru-RU")
    await app.restart()

    const russian = await screens.onboarding.primaryLabel()
    expect(await screens.appLanguage.code()).toBe("ru")
    // Not just "some other string": the copy has to come out in the script the
    // locale actually implies.
    expect(russian).not.toBe(english)
    expect(russian).toMatch(/\p{Script=Cyrillic}/u)
  })
})
