import type { DailyWisdom } from "@lib/domain/dailyWisdom.js"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import type { IDailyWisdomRepository } from "@lib/domain/ports/dailyWisdomRepository.js"
import type { ITopicRepository } from "@lib/domain/ports/topicRepository.js"

/** How many first lectures the onboarding offers. */
const LIMIT = 5
/** How deep each picked topic's pool goes before the draw. */
const POOL_PER_TOPIC = 12

/**
 * The first lectures for the topics a user picked: a pool of untagged lectures
 * tied to a verse — the strongest first listens — drawn from each topic, then
 * shuffled with `random` and cut to five, so the screen varies instead of
 * always showing the same top-weighted few.
 */
export async function pickTopicLectures(
  seeds: readonly TopicId[],
  languages: LanguageCode[],
  random: () => number,
  deps: { readonly topics: ITopicRepository }
): Promise<TrackId[]> {
  const pool: TrackId[] = []
  const seen = new Set<string>()
  for (const topic of seeds) {
    const ids = await deps.topics.topTrackIds(topic, languages, POOL_PER_TOPIC, {
      lecturesOnly: true,
      withReference: true,
    })
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id)
        pool.push(id)
      }
    }
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, LIMIT)
}

/**
 * The first featured ("for beginners") collection that has lectures, across
 * the user's content languages and then English and Russian.
 */
export async function pickBeginnerLectures(
  languages: LanguageCode[],
  deps: {
    readonly collections: {
      listFeaturedCollections(locale: string): Promise<readonly { readonly id: string }[]>
      getCollectionTrackIds(collectionId: string, locale: string): Promise<readonly string[]>
    }
  }
): Promise<TrackId[]> {
  const locales = [...new Set([...languages, "en", "ru"])] as LanguageCode[]
  for (const locale of locales) {
    const featured = await deps.collections.listFeaturedCollections(locale)
    for (const col of featured) {
      const ids = await deps.collections.getCollectionTrackIds(col.id, locale)
      if (ids.length > 0) return ids.slice(0, LIMIT) as TrackId[]
    }
  }
  return []
}

/**
 * One random daily-wisdom fragment for the onboarding preview — what the rule
 * delivers: an excerpt in the user's library language, then English or
 * Russian, then anything.
 */
export async function pickWisdomPreview(
  languages: readonly string[],
  random: () => number,
  deps: { readonly dailyWisdom: IDailyWisdomRepository }
): Promise<DailyWisdom | null> {
  const pick = (all: readonly DailyWisdom[]): DailyWisdom | null =>
    all.length === 0 ? null : all[Math.floor(random() * all.length)]
  const langs = [...new Set([...languages, "en", "ru"])] as LanguageCode[]
  for (const lang of langs) {
    const wisdom = pick(await deps.dailyWisdom.list(lang))
    if (wisdom) return wisdom
  }
  return pick(await deps.dailyWisdom.list())
}
