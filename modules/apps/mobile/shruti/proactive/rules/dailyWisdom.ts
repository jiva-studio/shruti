import { registerRule } from "../registry.js"
import type { ProactiveRuleHandler } from "../types.js"

/**
 * Daily wisdom: once a day, drop a short playable lecture excerpt into chat.
 *
 * The fragment is picked **at random from the whole corpus** — not by the
 * user's topics. Scoping it to a few interest topics drains the small per-topic
 * pool fast (it would repeat or run dry), so we draw from everything and only
 * constrain by language.
 *
 * Flow:
 * 1. Restrict to the user's library (lecture) languages — a fragment is only
 *    eligible if it's in a language the user actually reads. Better to skip a
 *    day than deliver an excerpt the user can't understand.
 * 2. Pick a random fragment in one of those languages.
 * 3. Emit it as a SILENT chat message (`visibleAt: null`, `notify: false`) —
 *    the fragment renders as a playable cite card. The separate daily-reminder
 *    push (notificationPlanner) provides the OS nudge, so the message still
 *    appears in chat even when notification permission was denied.
 *
 * `ruleDate = wisdom.id` so `UNIQUE(rule_kind, rule_date)` shows each fragment
 * at most once across the retention window; `cooldown_hours: 24` caps it to one
 * per day. Gated only on the user's daily-engagement toggle
 * (`settings.notificationsEnabled`) — off → the rule stays silent.
 */
export const dailyWisdomRule: ProactiveRuleHandler = {
  id: "daily_wisdom",

  async detect(ctx) {
    if (!ctx.notificationsEnabled) return []

    // Each library language, in random order, so a multi-language user isn't
    // biased to the first. `undefined` (no library filter set) = any language.
    const langs = ctx.libraryLanguages.length > 0 ? shuffle(ctx.libraryLanguages) : [undefined]

    for (const lang of langs) {
      const wisdom = pickRandom(await ctx.repos.dailyWisdom.list(lang))
      if (wisdom === null) continue

      return [
        {
          ruleDate: wisdom.id,
          visibleAt: null,
          notify: false,
          sessionTitleOverride: ctx.t("chat.proactiveSessionTitleDailyWisdom"),
          templateContext: {},
        },
      ]
    }
    return []
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
    // Pre-seed the cite snippet so CitationCard renders the full quote card
    // (with text + an inline player that cuts from the track audio), instead of
    // degrading to a chip whose server-cut excerpt doesn't exist for a
    // client-minted cite — see the `cites` note on ProactiveRuleHandler.
    return {
      bodyMd: `${intro}\n\n${marker}`,
      cites: {
        [`${wisdom.trackId}|${wisdom.startMs}-${wisdom.endMs}`]: { text: wisdom.text },
      },
    }
  },
}

function pickRandom<T>(arr: readonly T[]): T | null {
  if (arr.length === 0) return null
  return arr[Math.floor(Math.random() * arr.length)]
}

function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

registerRule(dailyWisdomRule)
