import { world } from "../src/world.js"

// FileProvider's refusal never crashes anything: the plugin turns it into a
// rejected bridge call, which is the only place the message survives.
const FILEPROVIDER_FAILURE =
  /Failed to find configured root|IllegalArgumentException[^\n]*\/files\/lectorium/

/**
 * Audio is the one share format that leaves the WebView carrying a file: the
 * plugin maps the downloader's path through FileProvider, and a path under no
 * configured root fails silently — the chooser opens either way, with nothing
 * attached to it.
 */
describe("sharing a lecture's audio hands over the file", () => {
  const { chooser, logs, storage, ui, journeys } = world()
  let audioFile = ""

  before(async () => {
    await journeys.startFresh()
    await journeys.queueFirstTrack()
    await browser.waitUntil(async () => (await storage.audioFiles()).length > 0, {
      timeout: 120_000,
      interval: 3_000,
      timeoutMsg: "the download never landed on disk",
    })
    audioFile = (await storage.audioFiles())[0]!.split("/").pop()!
    await logs.clear()
  })

  after(async () => {
    await ui.pressBack()
    await chooser.waitUntilClosed()
  })

  it("opens the system chooser", async () => {
    await journeys.shareFirstTrackAudio()
    await chooser.waitUntilOpen()
  })

  it("attaches the downloaded file to it", async () => {
    expect(await chooser.grantsReadAccess()).toBe(true)
    const shared = await chooser.sharedUris()
    expect(shared.some((uri) => decodeURIComponent(uri).endsWith(audioFile))).toBe(true)
  })

  it("leaves no FileProvider failure behind", async () => {
    expect(await logs.linesMatching(FILEPROVIDER_FAILURE)).toEqual([])
  })
})
