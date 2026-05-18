import type { ProactiveRuleHandler } from "../types.js"
import { registerRule } from "../registry.js"

/** Single action id per message — we only render one card so a stable
 *  string is enough. The marker token uses the same value. */
const ACTION_ID = "main"
/** Default firing time for the daily reminder we propose. The user can
 *  later change it via Settings; the card is just the opener. */
const DEFAULT_REMINDER_TIME = "07:00"

/**
 * "Hey, you've been here three days running — want a nudge each
 * morning so you don't lose the rhythm?"
 *
 * Eligibility is gated entirely by predicates in the bundled config
 * (`current_streak_at_least: 3`, `has_notifications_permission: false`).
 * The detector only needs to decide whether to fire today; the cooldown
 * (30 days) keeps us from nagging the user repeatedly.
 *
 * Visibility is immediate (`visible_on: null`) and notification is
 * silent (`notify_at: null`) — the card surfaces inline in the user's
 * current chat session with a badge bump, not as a system push.
 */
const handler: ProactiveRuleHandler = {
  id: "enable_notifications_hint",

  async detect(ctx) {
    return [
      {
        ruleDate: ctx.localDate,
        visibleOn: null,
        notifyAt: null,
        templateContext: {},
      },
    ]
  },

  async validate(_entry, ctx) {
    // If the user has granted notifications in the meantime, drop the
    // row — the action card would be a no-op.
    return !ctx.hasNotificationsPermission
  },

  async buildContent(_entry, ctx) {
    const body = ctx.t("chat.proactiveEnableNotificationsBody")
    const marker = `[action:enable_daily_reminder|id=${ACTION_ID}]`
    return {
      bodyMd: `${body}\n\n${marker}`,
      actions: {
        [ACTION_ID]: {
          kind: "enable_daily_reminder",
          id: ACTION_ID,
          time: DEFAULT_REMINDER_TIME,
        },
      },
    }
  },
}

registerRule(handler)
