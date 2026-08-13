import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

/** Tapping the icon again must resume the task, not stack a second activity. */
describe("relaunch from the launcher", () => {
  const { app, media, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
    await app.leaveInBackground()
  })

  it("does not stack a second activity", async () => {
    await app.returnToForeground()
    await screens.tabs.waitUntilVisible()
    expect(await app.taskCount()).toBe(1)
  })

  it("does not interrupt playback", async () => {
    expect(await media.state()).toBe(PlaybackState.Playing)
  })
})
