import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

/**
 * What the app is put through here is the window split screen leaves it with —
 * `WINDOWING_MODE_MULTI_WINDOW` at half the display's height, delivered as a
 * real configuration change. It is NOT SysUI's split screen: API 36 has no
 * shell command that raises the divider or docks a second app, and driving
 * Recents by hand is exactly the flaky UI automation this suite avoids.
 *
 * The first `it` therefore proves the window really changed before the rest
 * reads anything into the app still working.
 */
describe("split screen", () => {
  const { windowing, media, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
  })

  after(async () => {
    await windowing.leaveSplitScreen()
  })

  it("gives the app half the display in multi-window mode", async () => {
    await windowing.enterSplitScreen()
    const display = await windowing.displayBounds()
    const window = await windowing.bounds()

    expect(await windowing.mode()).toBe("multi-window")
    expect(window.height).toBeLessThan(display.height * 0.75)
  })

  it("keeps playing and stays navigable while split", async () => {
    expect(await media.state()).toBe(PlaybackState.Playing)
    await screens.tabs.go("search")
    expect(await screens.search.firstTrackTitle()).not.toBe("")
  })

  it("comes back usable full screen", async () => {
    await windowing.leaveSplitScreen()
    expect(await windowing.mode()).toBe("fullscreen")

    await screens.tabs.go("home")
    expect(await screens.player.isVisible()).toBe(true)
    expect(await media.state()).toBe(PlaybackState.Playing)
  })
})
