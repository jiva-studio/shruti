import type { LanguageCode, TopicId } from "@lib/domain/core.js"
import type { Topic } from "@lib/domain/topic.js"
import type { ITopicRepository } from "@lib/domain/ports/topicRepository.js"
import type { IKeyValueRepository } from "@lib/domain/ports/keyValueRepository.js"

/** One selectable topic chip in the onboarding picker. */
export interface OnboardingTopicOption {
  id: string
  label: string
}

/** Curated key in the catalog key_value store (set via the MCP config registry). */
export const ONBOARDING_TOPICS_KEY = "onboarding.topics"

/** How many topics to show when no curated list is published (fallback path). */
export const CURATED_FALLBACK_LIMIT = 12

interface TopicLoaderRepos {
  topics: ITopicRepository
  keyValue: IKeyValueRepository
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
 * the catalog `key_value` store (ordered, editorial); falls back to topics that
 * have lectures in the user's library languages so the screen is never empty.
 */
export async function loadOnboardingTopics(
  repos: TopicLoaderRepos,
  lang: LanguageCode,
  languageCodes: readonly LanguageCode[]
): Promise<OnboardingTopicOption[]> {
  const curatedIds = parseIds(await repos.keyValue.get(ONBOARDING_TOPICS_KEY))
  let topics = await repos.topics.getByIds(curatedIds)

  if (topics.length === 0) {
    const usable = await repos.topics.topicIdsWithTracksIn(languageCodes)
    topics = await repos.topics.getByIds(usable.slice(0, CURATED_FALLBACK_LIMIT))
  }

  return topics.map((t) => ({ id: t.id, label: label(t, lang) }))
}
