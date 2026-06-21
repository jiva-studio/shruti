import type { LanguageCode } from "../core.js"
import type { DailyWisdom } from "../dailyWisdom.js"

/**
 * Read access to the catalog's `daily_wisdom` corpus. Shipped in current.db,
 * authored on the MCP side. The daily-wisdom proactive rule draws a random
 * fragment in the user's library language.
 */
export interface IDailyWisdomRepository {
  /** One fragment by id, or null when absent. */
  byId(id: string): Promise<DailyWisdom | null>
  /** All fragments, optionally filtered to `language` (omit = any language).
   *  Empty when none exist (or the table predates this feature on an older
   *  bundled DB). */
  list(language?: LanguageCode): Promise<readonly DailyWisdom[]>
}
