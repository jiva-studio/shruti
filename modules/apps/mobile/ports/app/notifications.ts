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
  /**
   * Opaque payload echoed back via the
   * `localNotificationActionPerformed` event when the user taps the
   * notification. The proactive scheduler stuffs
   * `{ chatSessionId, chatMessageId }` here so the tap can deep-link
   * into the originating chat session. Callers with no need to receive
   * a callback (e.g., the daily reminder) leave this empty and are
   * filtered out by the tap listener.
   */
  extra?: Record<string, unknown>
}

export interface INotificationScheduler {
  /**
   * Inspect the current permission state without prompting. Returns the
   * same shape as `requestPermission`. Use this when you need to gate
   * behaviour on permission (e.g., proactive scheduler eligibility)
   * without surfacing the OS dialog.
   */
  checkPermission(): Promise<"granted" | "denied" | "unknown">
  requestPermission(): Promise<"granted" | "denied" | "unknown">
  schedule(n: ScheduledNotification): Promise<void>
  cancel(id: number): Promise<void>
  cancelAll(): Promise<void>
}
