import type { Clock, ClockSnapshot } from "../../ports/Clock.js"
import type { Adb } from "./Adb.js"

const SECONDS_PER_DAY = 86_400

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/** `MMDDhhmmYYYY.ss` — the only shape toybox's `date` accepts as a setter. */
function stamp(at: Date): string {
  return (
    pad(at.getUTCMonth() + 1) +
    pad(at.getUTCDate()) +
    pad(at.getUTCHours()) +
    pad(at.getUTCMinutes()) +
    String(at.getUTCFullYear()) +
    "." +
    pad(at.getUTCSeconds())
  )
}

export class AndroidClock implements Clock {
  constructor(private readonly adb: Adb) {}

  async snapshot(): Promise<ClockSnapshot> {
    return {
      at: new Date(Number(this.adb.shell("date +%s").trim()) * 1000),
      timeZone: this.adb.shell("getprop persist.sys.timezone").trim(),
      takenAtHostMs: Date.now(),
    }
  }

  async today(): Promise<string> {
    return this.adb.shell("date +%Y-%m-%d").trim()
  }

  async nextMidnight(): Promise<Date> {
    // Epoch and time-of-day in one call: two would straddle a second boundary
    // often enough to place the midnight a second out.
    const [epoch, hours, minutes, seconds] = this.adb
      .shell('date "+%s %H %M %S"')
      .trim()
      .split(/\s+/)
      .map(Number)
    const sinceMidnight = hours * 3600 + minutes * 60 + seconds
    return new Date((epoch - sinceMidnight + SECONDS_PER_DAY) * 1000)
  }

  async set(at: Date): Promise<void> {
    // `-u`, so the stamp is UTC and the runner's own timezone never enters it.
    this.adb.rootShell(`date -u ${stamp(at)}`)
  }

  async setTimeZone(id: string): Promise<void> {
    this.adb.rootShell(`setprop persist.sys.timezone ${id}`)
  }

  async restore(snapshot: ClockSnapshot): Promise<void> {
    // The reading is only true for the instant it was taken; the spec has run
    // since, so give back a clock that has moved on by the same real time.
    const at = new Date(snapshot.at.getTime() + (Date.now() - snapshot.takenAtHostMs))
    this.adb.rootShell(`setprop persist.sys.timezone ${snapshot.timeZone}`)
    this.adb.rootShell(`date -u ${stamp(at)}`)
  }
}
