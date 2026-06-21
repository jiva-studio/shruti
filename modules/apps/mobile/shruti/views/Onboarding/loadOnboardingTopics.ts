import type { LanguageCode, TopicId } from "@lib/domain/core.js"
import type { Topic } from "@lib/domain/topic.js"
import type { ITopicRepository } from "@lib/domain/ports/topicRepository.js"
import type { ISettingsRepository } from "@lib/domain/ports/settingsRepository.js"
import type { IDailyWisdomRepository } from "@lib/domain/ports/dailyWisdomRepository.js"

/** One selectable topic chip in the onboarding picker. */
export interface OnboardingTopicOption {
  id: string
  label: string
}

/** Curated key in the catalog settings store (set via the MCP config registry). */
export const ONBOARDING_TOPICS_KEY = "onboarding.topics"

/** How many topics to show when no curated list is published (fallback path). */
export const CURATED_FALLBACK_LIMIT = 12

interface TopicLoaderRepos {
  topics: ITopicRepository
  settings: ISettingsRepository
}

function label(topic: Topic, lang: LanguageCode): string {
  return (
    topic.shortNames.get(lang) ??
    topic.names.get(lang) ??
    [...topic.shortNames.values()][0] ??
    [...topic.names.values()][0] ??
    topic.id
  )
}

function parseIds(raw: string | null): TopicId[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === "string") as TopicId[]
  } catch {
    return []
  }
}

/**
 * Resolve the onboarding topic picker's options. Prefers the curated list from
 * the catalog `settings` store (ordered, editorial); falls back to topics that
 * have lectures in the user's library languages so the screen is never empty.
 */
export async function loadOnboardingTopics(
  repos: TopicLoaderRepos,
  lang: LanguageCode,
  languageCodes: readonly LanguageCode[]
): Promise<OnboardingTopicOption[]> {
  const curatedIds = parseIds(await repos.settings.get(ONBOARDING_TOPICS_KEY))
  let topics = await repos.topics.getByIds(curatedIds)

  // No published `onboarding.topics` → popularity, so the screen is never empty.
  // The curated list itself lives ONLY in the catalog DB (set via the MCP
  // config registry), never in app code.
  if (topics.length === 0) {
    const usable = await repos.topics.topicIdsWithTracksIn(languageCodes)
    topics = await repos.topics.getByIds(usable.slice(0, CURATED_FALLBACK_LIMIT))
  }

  return topics.map((t) => ({ id: t.id, label: label(t, lang) }))
}

/**
 * Topics that actually have a daily-wisdom fragment in the corpus — the options
 * for the Settings "Daily wisdom" picker. Selecting any of these (persisted to
 * the same `onboarding.interestTopicIds` the rule samples) turns on the
 * in-chat wisdom; an empty pick leaves only the plain daily reminder.
 */
export async function loadDailyWisdomTopics(
  repos: { topics: ITopicRepository; dailyWisdom: IDailyWisdomRepository },
  lang: LanguageCode
): Promise<OnboardingTopicOption[]> {
  const all = await repos.dailyWisdom.list()
  const ids = [...new Set(all.map((w) => w.topicId))] as TopicId[]
  if (ids.length === 0) return []
  const topics = await repos.topics.getByIds(ids)
  return topics.map((t) => ({ id: t.id, label: label(t, lang) }))
}
