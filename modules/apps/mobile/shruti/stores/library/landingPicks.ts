import { resolveAssetUrl } from "@shruti/services/regionsRegistry.js"
import { shuffled } from "@shruti/utils/shuffle.js"
import type {
  CollectionGroupView,
  GroupCollection,
} from "@shruti/stores/library/landingSources.js"
import type { CarouselItem } from "@ui/features/collections/index.js"
import type { Topic } from "@lib/domain/topic.js"
import type { Track } from "@lib/domain/track.js"
import type { TopicId } from "@lib/domain/core.js"

// How much of each section the landing actually shows.
const OTHER_COLLECTIONS = 4
const TOPIC_TILES = 6
const PREVIEW_LECTURES = 10

export interface LandingPicksInput {
  readonly topGroups: readonly CollectionGroupView[]
  readonly allCollections: readonly GroupCollection[]
  readonly topics: readonly Topic[]
  readonly topicShortNamesById: ReadonlyMap<string, string>
  /** Topics already shown as listening shelves, so a tile never repeats one. */
  readonly shelfTopicIds: ReadonlySet<TopicId>
  /** Topics with ≥1 lecture in the selected languages; `null` = no filter. */
  readonly allowedTopicIds: ReadonlySet<TopicId> | null
  readonly lecturePool: readonly Track[]
}

export interface LandingPicks {
  readonly otherCollections: readonly GroupCollection[]
  readonly topicTiles: readonly CarouselItem[]
  readonly lectureSample: readonly Track[]
}

function pickTopicTiles(input: LandingPicksInput): readonly CarouselItem[] {
  const allowed = input.allowedTopicIds
  const candidates = input.topics.filter(
    (t) => !input.shelfTopicIds.has(t.id) && (allowed === null || allowed.has(t.id))
  )
  return shuffled(candidates)
    .slice(0, TOPIC_TILES)
    .map((topic) => ({
      id: topic.id,
      name: input.topicShortNamesById.get(topic.id) ?? topic.id,
      coverUrl: topic.cover ? resolveAssetUrl(topic.cover) : undefined,
    }))
}

/**
 * The exact subsets the landing renders, derived once per load: a random sample
 * each time, so the page shows variety between visits. Collections and topics
 * already on screen above are excluded so nothing appears twice.
 */
export function pickLandingSections(input: LandingPicksInput): LandingPicks {
  const shownIds = new Set(input.topGroups.flatMap((g) => g.collections.map((c) => c.id)))
  return {
    otherCollections: shuffled(input.allCollections.filter((c) => !shownIds.has(c.id))).slice(
      0,
      OTHER_COLLECTIONS
    ),
    topicTiles: pickTopicTiles(input),
    lectureSample: shuffled(input.lecturePool).slice(0, PREVIEW_LECTURES),
  }
}
