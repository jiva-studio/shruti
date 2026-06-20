import type { LanguageCode, TopicId } from "../core.js"
import type { DailyWisdom } from "../dailyWisdom.js"

/**
 * Read access to the catalog's `daily_wisdom` corpus. Shipped in current.db,
 * authored on the MCP side. The daily-wisdom proactive rule uses this to pick
 * a fragment for one of the user's chosen topics.
 */
export interface IDailyWisdomRepository {
  /** One fragment by id, or null when absent. */
  byId(id: string): Promise<DailyWisdom | null>
  /** Wisdom fragments for a topic, optionally filtered to `language`
   *  (omit = any language). Empty when none exist (or the table predates
   *  this feature on an older bundled DB). */
  byTopic(topicId: TopicId, language?: LanguageCode): Promise<readonly DailyWisdom[]>
  /** Of `topicIds`, those that have at least one fragment (optionally in
   *  `language`) — lets the rule sample only topics it can deliver. */
  topicsWithWisdom(
    topicIds: readonly TopicId[],
    language?: LanguageCode
  ): Promise<readonly TopicId[]>
}
