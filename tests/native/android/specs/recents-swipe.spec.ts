import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

/**
 * A Recents swipe is neither `am kill` nor backgrounding: the task and its
 * activity go, the process and its foreground service need not. No app code
 * decides — the service declares no `stopWithTask` and overrides no
 * `onTaskRemoved` — so media3 does: it keeps a service whose player is playing
 * and pauses-and-stops one whose player is not. Both halves are pinned here,
 * because a media3 bump could just as easily cut a lecture off mid-sentence as
 * strand a foreground service holding a dead player.
 */
describe("swiped out of Recents", () => {
  const { app, media, journeys, screens } = world()

  const audioService = async () =>
    (await app.runningServices()).find((service) => service.name.endsWith("AudioPlayerService"))

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
    await app.removeFromRecents()
  })

  it("drops the task", async () => {
    expect(await app.taskCount()).toBe(0)
  })

  it("plays on without an activity", async () => {
    await browser.pause(5_000)
    expect(await media.state()).toBe(PlaybackState.Playing)
  })

  it("keeps the player in a foreground service", async () => {
    expect((await audioService())?.foreground).toBe(true)
  })

  it("keeps a notification that still reaches the player", async () => {
    expect(await media.hasPostedNotification()).toBe(true)
    await media.dispatch("pause")
    await media.waitUntilState(PlaybackState.Paused)
  })

  describe("swiped away while paused", () => {
    before(async () => {
      await app.returnToForeground()
      await screens.tabs.waitUntilVisible()
      await media.dispatch("pause")
      await media.waitUntilState(PlaybackState.Paused)
      await app.removeFromRecents()
    })

    it("stops the service", async () => {
      // The service unbinds only once the destroyed activity's controller lets
      // go, so `stopSelf` lands a beat after the task disappears.
      await browser.waitUntil(async () => (await app.runningServices()).length === 0, {
        timeout: 30_000,
        interval: 1_000,
        timeoutMsg: "the audio service outlived the task",
      })
    })

    it("takes the media session with it", async () => {
      expect(await media.state()).toBeNull()
    })

    it("leaves nothing in the shade", async () => {
      expect(await media.hasPostedNotification()).toBe(false)
    })
  })
})
