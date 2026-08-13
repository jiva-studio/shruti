import type { NotificationSchedule } from "../../ports/NotificationSchedule.js"
import type { Adb } from "./Adb.js"

/** Every notification the app schedules is armed as an AlarmManager broadcast
 *  to the local-notifications plugin's publisher, which names it in the dump —
 *  so this counts notifications, not the app's other alarms (WorkManager). */
const PUBLISHER = "com.capacitorjs.plugins.localnotifications"

/** The dump repeats the same receiver in its trailing history sections, where a
 *  long-fired alarm would read as pending. */
const HISTORY = /^\s*(?:Top Alarms|Alarm Stats):/m

export class AndroidNotificationSchedule implements NotificationSchedule {
  constructor(private readonly adb: Adb) {}

  async pendingAlarms(): Promise<number> {
    const pending = this.adb.shell("dumpsys alarm").split(HISTORY)[0]!
    return pending
      .split("\n")
      .filter((line) => line.trimStart().startsWith("tag=") && line.includes(PUBLISHER)).length
  }

  async waitUntilArmed(atLeast: number, timeoutMs = 90_000): Promise<void> {
    await browser.waitUntil(async () => (await this.pendingAlarms()) >= atLeast, {
      timeout: timeoutMs,
      interval: 3_000,
      timeoutMsg: `the OS holds fewer than ${atLeast} alarms for the app's notifications`,
    })
  }
}
