/**
 * What the OS holds on the app's behalf for notifications that fire later.
 * A reminder only exists once the alarm is here — the app is closed when the
 * moment comes.
 */
export interface NotificationSchedule {
  pendingAlarms(): Promise<number>
  waitUntilArmed(atLeast: number, timeoutMs?: number): Promise<void>
}
