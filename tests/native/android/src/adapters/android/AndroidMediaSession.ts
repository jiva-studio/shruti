import { PlaybackState, type MediaSession } from "../../ports/MediaSession.js"
import type { Adb } from "./Adb.js"

const STATE = /state=PlaybackState\s*\{state=[A-Z_]+\((\d+)\)/
const POSITION = /state=PlaybackState\s*\{state=[A-Z_]+\(\d+\),\s*position=(\d+)/

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

  async dispatch(action: "play" | "pause" | "play-pause"): Promise<void> {
    this.adb.shell(`cmd media_session dispatch ${action}`)
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
}
