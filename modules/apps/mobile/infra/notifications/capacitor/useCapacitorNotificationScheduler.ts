import { LocalNotifications } from "@capacitor/local-notifications"
import type { INotificationScheduler, ScheduledNotification } from "@ports/app/notifications.js"

/**
 * Thin adapter over `@capacitor/local-notifications`. Works on web too —
 * Capacitor will no-op the plugin when the browser doesn't grant
 * permission, and the caller's `requestPermission` result tells them.
 */
export function useCapacitorNotificationScheduler(): INotificationScheduler {
  return {
    async requestPermission() {
      const result = await LocalNotifications.requestPermissions()
      // Capacitor returns "granted" | "denied" | "prompt" | "default" —
      // map anything that isn't an explicit grant/deny to "unknown" so
      // the caller doesn't have to know the platform dialect.
      if (result.display === "granted") return "granted"
      if (result.display === "denied") return "denied"
      return "unknown"
    },

    async schedule(n: ScheduledNotification) {
      await LocalNotifications.schedule({
        notifications: [
          {
            id: n.id,
            title: n.title,
            body: n.body,
            schedule: { at: new Date(n.at) },
          },
        ],
      })
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
