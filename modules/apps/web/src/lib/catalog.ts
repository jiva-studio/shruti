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
import type { Lang } from '../i18n/ui'

export const lectures = lecturesIndex as unknown as LectureIndexEntry[]
export const topics = topicsIndex as unknown as TopicIndexEntry[]

const collIndex = collectionsIndex as unknown as CollectionsIndex
export const collectionGroups: CollectionGroupIndexEntry[] = collIndex.groups
export const collectionsById: Record<string, CollectionIndexEntry> = collIndex.collections
export const collections: CollectionIndexEntry[] = Object.values(collIndex.collections)

const lectureById = new Map(lectures.map((l) => [l.id, l]))
export function lectureFor(id: string): LectureIndexEntry | undefined {
  return lectureById.get(id)
}
export function lecturesByIds(ids: string[]): LectureIndexEntry[] {
  const out: LectureIndexEntry[] = []
  for (const id of ids) {
    const l = lectureById.get(id)
    if (l) out.push(l)
  }
  return out
}

const topicBySlug = new Map(topics.map((t) => [t.slug, t]))
const topicById = new Map(topics.map((t) => [t.id, t]))
export function topicForSlug(slug: string): TopicIndexEntry | undefined {
  return topicBySlug.get(slug)
}
export function topicForId(id: string): TopicIndexEntry | undefined {
  return topicById.get(id)
}

const collectionBySlug = new Map(collections.map((c) => [c.slug, c]))
export function collectionForSlug(slug: string): CollectionIndexEntry | undefined {
  return collectionBySlug.get(slug)
}
export function collectionForId(id: string): CollectionIndexEntry | undefined {
  return collectionsById[id]
}

// Lectures newest-first for the flat catalog listing.
export const lecturesByDate: LectureIndexEntry[] = [...lectures].sort((a, b) =>
  String(b.date ?? '').localeCompare(String(a.date ?? ''))
)

export function pickName(map: Record<string, string> | undefined, lang: Lang): string {
  if (!map) return ''
  return map[lang] || map.en || Object.values(map)[0] || ''
}

export function shortSlug(slug: string): string {
  return slug.replace(/^track_/, '')
}

export interface Paged<T> {
  items: T[]
  page: number
  lastPage: number
  total: number
}

export function paginate<T>(items: T[], page: number, perPage: number): Paged<T> {
  const total = items.length
  const lastPage = Math.max(1, Math.ceil(total / perPage))
  const p = Math.min(Math.max(1, page), lastPage)
  const start = (p - 1) * perPage
  return { items: items.slice(start, start + perPage), page: p, lastPage, total }
}
