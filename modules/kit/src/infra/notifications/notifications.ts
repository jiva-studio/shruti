/**
 * Port for local (on-device) notifications. Scheduling a notification
 * does not require network access or a backend.
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
   * repeating alarm so daily reminders survive device reboots without
   * the app being relaunched. Without it the notification is one-shot.
   */
  every?: "day"
  /**
   * Opaque payload echoed back to the app when the user taps the
   * notification (e.g. via the platform's notification-action event).
   * Callers that don't need a tap callback leave this empty.
   */
  extra?: Record<string, unknown>
}

export type NotificationPermission = "granted" | "denied" | "unknown"

/**
 * Thrown by {@link INotificationScheduler.schedule} when the OS refuses to
 * arm a notification because the user hasn't granted (or has revoked) the
 * app's notification permission. This is a user/permission state, NOT an app
 * fault — callers should skip it silently and let the next reconcile retry if
 * permission is later granted. Adapters map the platform's opaque reject into
 * this typed error so callers can `instanceof`-check instead of matching a
 * localized message string, and so it stays out of crash reporting.
 */
export class NotificationsDisabledError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Notifications are not enabled for this app", options)
    this.name = "NotificationsDisabledError"
  }
}

export interface INotificationScheduler {
  /**
   * Inspect the current permission state without prompting. Use this to
   * gate behaviour on permission without surfacing the OS dialog.
   */
  checkPermission(): Promise<NotificationPermission>
  requestPermission(): Promise<NotificationPermission>
  schedule(n: ScheduledNotification): Promise<void>
  cancel(id: number): Promise<void>
  cancelAll(): Promise<void>
}
