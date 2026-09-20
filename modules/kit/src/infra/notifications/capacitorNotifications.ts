import { LocalNotifications } from "@capacitor/local-notifications"
import {
  NotificationsDisabledError,
  type INotificationScheduler,
  type NotificationPermission,
  type ScheduledNotification,
} from "./notifications.js"

function mapPermission(display: string): NotificationPermission {
  // Capacitor returns "granted" | "denied" | "prompt" | "default" — map
  // anything that isn't an explicit grant/deny to "unknown" so callers
  // don't have to know the platform dialect.
  if (display === "granted") return "granted"
  if (display === "denied") return "denied"
  return "unknown"
}

/**
 * Thin {@link INotificationScheduler} over `@capacitor/local-notifications`.
 * Works on web too — Capacitor no-ops the plugin when the browser doesn't
 * grant permission, and the caller's `requestPermission` result tells them.
 */
export function useCapacitorNotificationScheduler(): INotificationScheduler {
  return {
    async checkPermission() {
      const result = await LocalNotifications.checkPermissions()
      return mapPermission(result.display)
    },

    async requestPermission() {
      const result = await LocalNotifications.requestPermissions()
      return mapPermission(result.display)
    },

    async schedule(n: ScheduledNotification) {
      try {
        if (n.every === "day") {
          // Daily recurrence: fire at the same local hour/minute every day.
          // Capacitor's `on: { hour, minute }` schedules the next occurrence
          // and re-arms itself on fire — on Android this rides over reboots
          // (the plugin auto-registers RECEIVE_BOOT_COMPLETED) and avoids the
          // iOS calendar limitation of one-off alarms.
          const date = new Date(n.at)
          await LocalNotifications.schedule({
            notifications: [
              {
                id: n.id,
                title: n.title,
                body: n.body,
                schedule: {
                  on: { hour: date.getHours(), minute: date.getMinutes() },
                  allowWhileIdle: true,
                },
                extra: n.extra ?? null,
              },
            ],
          })
          return
        }
        await LocalNotifications.schedule({
          notifications: [
            {
              id: n.id,
              title: n.title,
              body: n.body,
              // `allowWhileIdle` so Doze / app-standby on a backgrounded device
              // doesn't defer the alarm — the whole point of these is to fire
              // while the app is frozen (e.g. a chat answer landing after the
              // user left). Without it Android batches the alarm to the next
              // maintenance window, which can be many minutes late.
              schedule: { at: new Date(n.at), allowWhileIdle: true },
              extra: n.extra ?? null,
            },
          ],
        })
      } catch (err) {
        // The OS rejects scheduling when notifications are disabled for the
        // app (Android throws "Notifications not enabled on this device").
        // Re-check permission rather than matching that reject string — this
        // stays robust across plugin versions/locales, and a genuine failure
        // WITH permission granted still propagates as the original error so it
        // remains visible. See NotificationsDisabledError.
        if (mapPermission((await LocalNotifications.checkPermissions()).display) !== "granted") {
          throw new NotificationsDisabledError({ cause: err })
        }
        throw err
      }
    },

    async cancel(id: number) {
      await LocalNotifications.cancel({ notifications: [{ id }] })
    },

    async cancelAll() {
      const pending = await LocalNotifications.getPending()
      if (pending.notifications.length === 0) return
      await LocalNotifications.cancel({ notifications: pending.notifications })
    },
  }
}
