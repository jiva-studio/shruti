import type { ProactiveRuleHandler } from "../types.js"
import { dailyWisdomRule } from "./dailyWisdom.js"
import { enableNotificationsHintRule } from "./enableNotificationsHint.js"
import { holidayRule } from "./holiday.js"
import { inactivityRule } from "./inactivity.js"
import { nextShlokaRule } from "./nextShloka.js"
import { smartLibraryHintRule } from "./smartLibraryHint.js"
import { unfinishedLectureRule } from "./unfinishedLecture.js"
import { weeklyDigestRule } from "./weeklyDigest.js"

/** Every rule the app knows how to run; the published config decides which are on. */
export const PROACTIVE_RULES: readonly ProactiveRuleHandler[] = [
  enableNotificationsHintRule,
  smartLibraryHintRule,
  weeklyDigestRule,
  inactivityRule,
  holidayRule,
  nextShlokaRule,
  dailyWisdomRule,
  unfinishedLectureRule,
]
