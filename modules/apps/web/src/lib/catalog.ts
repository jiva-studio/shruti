import lecturesIndex from '../data/lectures-index.json'
import topicsIndex from '../data/topics-index.json'
import collectionsIndex from '../data/collections-index.json'
import type {
  LectureIndexEntry,
  TopicIndexEntry,
  CollectionIndexEntry,
  CollectionGroupIndexEntry,
  CollectionsIndex,
} from '@lib/catalog/types.js'

export { pickName } from './lectureDisplay'

export const lectures = lecturesIndex as unknown as LectureIndexEntry[]
export const topics = topicsIndex as unknown as TopicIndexEntry[]

const collIndex = collectionsIndex as unknown as CollectionsIndex
export const collectionGroups: CollectionGroupIndexEntry[] = collIndex.groups
export const collectionsById: Record<string, CollectionIndexEntry> = collIndex.collections
export const collections: CollectionIndexEntry[] = Object.values(collIndex.collections)

const lectureById = new Map(lectures.map((l) => [l.id, l]))
export function lecturesByIds(ids: string[]): LectureIndexEntry[] {
  const out: LectureIndexEntry[] = []
  for (const id of ids) {
    const l = lectureById.get(id)
    if (l) out.push(l)
  }
  return out
}

const topicById = new Map(topics.map((t) => [t.id, t]))
export function topicForId(id: string): TopicIndexEntry | undefined {
  return topicById.get(id)
}

export function collectionForId(id: string): CollectionIndexEntry | undefined {
  return collectionsById[id]
}

export function shortSlug(slug: string): string {
  return slug.replace(/^track_/, '')
}
