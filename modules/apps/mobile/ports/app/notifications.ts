/**
 * Port for local (on-device) notifications. Scheduling a notification does
 * not require network access or a backend.
 *
 * The port lives in the shared kit (`@kit/infra`); re-exported here so app
 * code keeps importing it from `@ports/app`. The proactive scheduler stuffs
 * `{ chatSessionId, chatMessageId }` into `ScheduledNotification.extra` so a
 * notification tap can deep-link into the originating chat session.
 */
export type { INotificationScheduler, ScheduledNotification } from "@kit/infra"
