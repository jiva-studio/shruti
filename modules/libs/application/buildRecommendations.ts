import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { ITopicRepository } from "@lib/domain/ports/topicRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"

/** One hot-topic shelf: the topic plus the tracks to show under it. */
export interface RecommendationShelf {
  readonly topicId: TopicId
  readonly tracks: readonly Track[]
}

export interface BuildRecommendationsInput {
  /** Wall-clock now (ms). Injected so the use case stays pure/testable. */
  readonly now: number
  /** Active UI language — shelves only show topic tracks with a variant in it. */
  readonly language: LanguageCode
  /** How far back the taste profile looks. */
  readonly historyWindowMs: number
  /** How many top topics become shelves. */
  readonly shelfTopics: number
  /** How many tracks to pull per shelf (before exclusion). */
  readonly shelfSize: number
  /** Size of the "Recommended for you" pick. */
  readonly recommendedSize: number
  /**
   * Excludes anything the discovery surface shouldn't resurface BESIDES the
   * heard tracks (which are derived here): typically completed + currently
   * queued. Heard ids are always excluded internally.
   */
  readonly isExcluded: (trackId: TrackId) => boolean
  /** Injected shuffle so the cold-start pick is deterministic in tests. */
  readonly shuffle: <T>(items: readonly T[]) => T[]
}

export interface BuildRecommendationsDeps {
  readonly listeningSessions: Pick<IListeningSessionRepository, "getTracksListenedInRange">
  readonly topics: Pick<ITopicRepository, "weightsForTracks" | "listAll" | "topTrackIds">
  readonly tracks: Pick<ITrackRepository, "getByIds">
}

export interface BuildRecommendationsResult {
  readonly recommended: readonly Track[]
  readonly shelves: readonly RecommendationShelf[]
  /** True when the profile was built from real listening history. */
  readonly hasHistory: boolean
}

/**
 * On-device recommender core. From listening history it derives a taste profile
 * (topic affinity = Σ weight × listened seconds), surfaces the most-listened
 * topics as shelves plus a "Recommended for you" pick, and never resurfaces a
 * track the user already heard, completed, or queued. With no history it
 * cold-starts on the first topics so nothing is empty.
 *
 * Extracted from useRecommendationsStore so the logic is testable in isolation;
 * the store is now a thin reactive shim that supplies `now`, the exclusion
 * predicate (from the playlist) and a shuffle, then assigns the result to refs.
 */
export async function buildRecommendations(
  input: BuildRecommendationsInput,
  deps: BuildRecommendationsDeps
): Promise<BuildRecommendationsResult> {
  const heard = await deps.listeningSessions.getTracksListenedInRange(
    input.now - input.historyWindowMs,
    input.now
  )
  const secondsByTrack = new Map(heard.map((h) => [h.trackId, h.listenedSeconds]))
  const heardIds = new Set(heard.map((h) => h.trackId))
  const excluded = (id: TrackId): boolean => heardIds.has(id) || input.isExcluded(id)

  let hotTopics: TopicId[] = []
  if (heardIds.size > 0) {
    const weights = await deps.topics.weightsForTracks([...heardIds])
    const affinity = new Map<TopicId, number>()
    for (const w of weights) {
      const seconds = secondsByTrack.get(w.trackId) ?? 0
      affinity.set(w.topicId, (affinity.get(w.topicId) ?? 0) + w.weight * seconds)
    }
    hotTopics = [...affinity.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, input.shelfTopics)
      .map(([id]) => id)
  }
  const hasHistory = hotTopics.length > 0

  // Cold start (or no topics matched the heard tracks): fall back to the first
  // topics so the shelves still populate.
  if (hotTopics.length === 0) {
    const all = await deps.topics.listAll()
    hotTopics = all.slice(0, input.shelfTopics).map((t) => t.id)
  }

  const shelves: RecommendationShelf[] = []
  const topPicks: TrackId[] = []
  for (const topicId of hotTopics) {
    const ids = (await deps.topics.topTrackIds(topicId, input.language, input.shelfSize)).filter(
      (id) => !excluded(id)
    )
    if (ids.length === 0) continue
    const byId = await deps.tracks.getByIds(ids)
    const tracks = ids.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
    if (tracks.length === 0) continue
    shelves.push({ topicId, tracks })
    if (tracks[0]) topPicks.push(tracks[0].id)
  }

  // "Recommended for you": with history, the top unheard pick from each hot
  // topic. On cold start, a few random unheard lectures from the shelf pool.
  const recPool = hasHistory
    ? [...new Set(topPicks)]
    : input.shuffle([...new Set(shelves.flatMap((s) => s.tracks.map((t) => t.id)))])
  const recIds = recPool.slice(0, input.recommendedSize)
  const recById = await deps.tracks.getByIds(recIds)
  const recommended = recIds.map((id) => recById.get(id)).filter((t): t is Track => t !== undefined)

  return { recommended, shelves, hasHistory }
}
