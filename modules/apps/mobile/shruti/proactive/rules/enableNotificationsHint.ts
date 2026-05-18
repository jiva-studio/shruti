import type { ProactiveRuleHandler } from "../types.js"
import { registerRule } from "../registry.js"

/** Single action id per message — we only render one card so a stable
 *  string is enough. The marker token uses the same value. */
const ACTION_ID = "main"
/** Default firing time for the daily reminder we propose. The user can
 *  later change it via Settings; the card is just the opener. */
const DEFAULT_REMINDER_TIME = "07:00"

/**
 * Tutorial-style introduction to the daily reminder feature. The
 * card shows up in its own chat session titled "Ежедневное
 * напоминание" — multi-paragraph body explaining what the reminder
 * does, then the action button to turn it on.
 *
 * Eligibility (predicates in bundled config): streak ≥ 3 days and
 * notification permission still off. Cooldown 30 days. Silent
 * (`notify: false`) — the chat-icon badge is the cue, no OS push.
 */
const handler: ProactiveRuleHandler = {
  id: "enable_notifications_hint",

  async detect(ctx) {
    return [
      {
        ruleDate: ctx.localDate,
        visibleAt: null,
        notify: false,
        // Localised session title resolved at detect time so the
        // bundled config stays free of i18n-key indirection.
        sessionTitleOverride: ctx.t("chat.proactiveSessionTitleEnableReminder"),
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
