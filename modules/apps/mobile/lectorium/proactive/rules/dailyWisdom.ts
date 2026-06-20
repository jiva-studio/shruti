import { registerRule } from "../registry.js"
import type { ProactiveRuleHandler } from "../types.js"

/**
 * Daily wisdom: once a day, drop a short playable lecture excerpt into chat,
 * sampled from one of the topics the user picked during onboarding.
 *
 * Flow:
 * 1. From the user's interest topics, keep those that actually have a wisdom
 *    fragment in the corpus.
 * 2. Pick a random such topic, then a random fragment for it.
 * 3. Emit it as a SILENT chat message (`visibleAt: null`, `notify: false`) —
 *    the fragment renders as a playable cite card. The separate daily-reminder
 *    push (notificationPlanner) provides the OS nudge, so the message still
 *    appears in chat even when notification permission was denied.
 *
 * `ruleDate = wisdom.id` so `UNIQUE(rule_kind, rule_date)` shows each fragment
 * at most once across the retention window; `cooldown_hours: 24` caps it to one
 * per day. Gated on the user's daily-engagement toggle + a non-empty interest
 * set — both off → the rule stays silent.
 */
const handler: ProactiveRuleHandler = {
  id: "daily_wisdom",

  async detect(ctx) {
    if (!ctx.notificationsEnabled || ctx.interestTopicIds.length === 0) return []

    const topicsWith = await ctx.repos.dailyWisdom.topicsWithWisdom(ctx.interestTopicIds)
    const topic = pickRandom(topicsWith)
    if (topic === null) return []

    const candidates = await ctx.repos.dailyWisdom.byTopic(topic)
    const wisdom = pickRandom(candidates)
    if (wisdom === null) return []

    return [
      {
        ruleDate: wisdom.id,
        visibleAt: null,
        notify: false,
        sessionTitleOverride: ctx.t("chat.proactiveSessionTitleDailyWisdom"),
        templateContext: {},
      },
    ]
  },

  async validate(entry, ctx) {
    // The fragment may have been dropped by a later catalog.publish.
    return (await ctx.repos.dailyWisdom.byId(entry.ruleDate)) !== null
  },

  async buildContent(entry, ctx) {
    const wisdom = await ctx.repos.dailyWisdom.byId(entry.ruleDate)
    if (wisdom === null) return null
    const intro = ctx.t("chat.proactiveDailyWisdomBody")
    // Cite markers can't contain `]` or newlines in the caption (see the
    // chat marker parser), so flatten the excerpt before embedding it.
    const caption = wisdom.text
      .replace(/[\r\n]+/g, " ")
      .replace(/\]/g, ")")
      .trim()
    const marker = `[cite:${wisdom.trackId}@${wisdom.startMs}-${wisdom.endMs}|${caption}]`
    return { bodyMd: `${intro}\n\n${marker}` }
  },
}

function pickRandom<T>(arr: readonly T[]): T | null {
  if (arr.length === 0) return null
  return arr[Math.floor(Math.random() * arr.length)]
}

registerRule(handler)
