import type { ProactiveRuleHandler } from "../types.js"
import { registerRule } from "../registry.js"

const ACTION_ID = "main"

/**
 * Generic Pro upsell for the auto-download "Smart Library" feature.
 * Surfaces once a user has finished a few lectures and isn't yet
 * subscribed (predicates in the bundled config). The card itself
 * routes through the paywall — the user can come back to the same
 * suggestion after upgrading.
 *
 * A later iteration can capture the topic/author the user is
 * actually searching for and pre-fill the filters; for now we ship
 * the plain pitch so the surface is wired end-to-end.
 */
const handler: ProactiveRuleHandler = {
  id: "smart_library_hint",

  async detect(ctx) {
    return [
      {
        ruleDate: ctx.localDate,
        visibleOn: null,
        notifyAt: null,
        sessionTitleOverride: ctx.t("chat.proactiveSessionTitleSmartLibrary"),
        templateContext: {},
      },
    ]
  },

  async validate(_entry, ctx) {
    // If the user has since subscribed, the card is no longer relevant.
    return !ctx.isSubscribed
  },

  async buildContent(_entry, ctx) {
    const body = ctx.t("chat.proactiveSmartLibraryHintBody")
    const marker = `[action:configure_smart_library|id=${ACTION_ID}]`
    return {
      bodyMd: `${body}\n\n${marker}`,
      actions: {
        [ACTION_ID]: {
          kind: "configure_smart_library",
          id: ACTION_ID,
          // Empty filter map — the card falls through to the paywall
          // for non-subscribers, and a subscribed user lands on the
          // Smart Library settings screen with no preset overrides.
          filters: {},
        },
      },
    }
  },
}

registerRule(handler)
