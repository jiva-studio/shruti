import { NotificationsDisabledError } from "@ports/app/notifications.js"
import type { ReportNotificationFailure } from "@usecases/proactive/notificationPlanner.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"

/**
 * Reports a push the planner could not schedule or cancel. Notifications
 * disabled for the app is a permission state, not a fault, so a schedule
 * refused for it pages nobody.
 */
export const reportNotifyPlannerFailure: ReportNotificationFailure = (err, op) => {
  if (op === "schedule" && err instanceof NotificationsDisabledError) return
  reportError("notify-planner", err)
}
