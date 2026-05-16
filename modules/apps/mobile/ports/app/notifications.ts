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
  /**
   * When set, the notification re-fires at the given interval (computed
   * from `at`'s local hour/minute). On Android this maps to a true
   * repeating exact-allow-while-idle alarm so daily reminders survive
   * device reboots without the app being relaunched. Without it the
   * notification is one-shot.
   */
  every?: "day"
}

export interface INotificationScheduler {
  requestPermission(): Promise<"granted" | "denied" | "unknown">
  schedule(n: ScheduledNotification): Promise<void>
  cancel(id: number): Promise<void>
  cancelAll(): Promise<void>
}
