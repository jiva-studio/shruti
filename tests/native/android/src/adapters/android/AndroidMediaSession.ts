import { PlaybackState, type MediaSession } from "../../ports/MediaSession.js"
import type { Adb } from "./Adb.js"

const STATE = /state=PlaybackState\s*\{state=[A-Z_]+\((\d+)\)/
const POSITION = /state=PlaybackState\s*\{state=[A-Z_]+\(\d+\),\s*position=(\d+)/

/** dumpsys renders the metadata as a comma-joined description; the title is
 *  the first field of it. */
function leadingField(text: string): string {
  return text.split(",")[0]!.trim()
}

export class AndroidMediaSession implements MediaSession {
  constructor(private readonly adb: Adb) {}

  private dump(): string | null {
    const dump = this.adb.shell("dumpsys media_session")
    return dump.includes(`package=${this.adb.appPackage}`) ? dump : null
  }

  async state(): Promise<PlaybackState | null> {
    const match = this.dump()?.match(STATE)
    return match ? (Number(match[1]) as PlaybackState) : null
  }

  async positionMs(): Promise<number | null> {
    const match = this.dump()?.match(POSITION)
    return match ? Number(match[1]) : null
  }

  async hasShadeNotification(): Promise<boolean> {
    return this.adb.shell("dumpsys notification --noredact").includes(this.adb.appPackage)
  }

  async dispatch(action: "play" | "pause" | "play-pause" | "next" | "previous"): Promise<void> {
    this.adb.shell(`cmd media_session dispatch ${action}`)
  }

  async trackTitle(): Promise<string | null> {
    const line = this.dump()?.match(/metadata: size=\d+, description=([^\n]*)/)?.[1] ?? null
    return line ? leadingField(line) : null
  }

  async transportActions(): Promise<{ next: boolean; previous: boolean; seek: boolean }> {
    const bits = Number(this.dump()?.match(/actions=(\d+)/)?.[1] ?? 0)
    return { next: !!(bits & 32), previous: !!(bits & 16), seek: !!(bits & 256) }
  }

  async waitUntilState(state: PlaybackState, timeoutMs = 30_000): Promise<void> {
    await browser.waitUntil(async () => (await this.state()) === state, {
      timeout: timeoutMs,
      interval: 1_000,
      timeoutMsg: `the media session never reached state ${state}`,
    })
  }

  async waitUntilPlaying(timeoutMs = 60_000): Promise<void> {
    await this.waitUntilState(PlaybackState.Playing, timeoutMs)
  }

  async waitUntilTrackTitle(title: string, timeoutMs = 90_000): Promise<void> {
    const expected = leadingField(title)
    await browser.waitUntil(async () => (await this.trackTitle()) === expected, {
      timeout: timeoutMs,
      interval: 1_000,
      timeoutMsg: `the media session never published "${expected}"`,
    })
  }

  async waitUntilNotPlaying(timeoutMs = 60_000): Promise<void> {
    await browser.waitUntil(async () => (await this.state()) !== PlaybackState.Playing, {
      timeout: timeoutMs,
      interval: 1_000,
      timeoutMsg: "playback never stopped",
    })
  }
}
