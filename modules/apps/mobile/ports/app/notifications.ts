/**
 * Port for local (on-device) notifications. Scheduling a notification does
 * not require network access or a backend.
 */
export interface ScheduledNotification {
  id: number
  title: string
  body: string
  /** Absolute unix time (ms) at which to fire. */
  at: number
}

export interface INotificationScheduler {
  requestPermission(): Promise<"granted" | "denied" | "unknown">
  schedule(n: ScheduledNotification): Promise<void>
  cancel(id: number): Promise<void>
  cancelAll(): Promise<void>
}
