import type { CarouselItem } from "@ui/features/collections/index.js"

/** A shelf entry, and which page opens it. */
export interface GroupingHit extends CarouselItem {
  readonly kind: "collection" | "topic"
}

export interface NamedCover {
  readonly id: string
  readonly name: string
  readonly coverUrl?: string
}

export function normalizeNeedle(query: string): string {
  return query.trim().toLocaleLowerCase()
}

export function matchCollections(
  collections: readonly NamedCover[],
  needle: string,
  limit: number
): GroupingHit[] {
  return collections
    .filter((c) => c.name.toLocaleLowerCase().includes(needle))
    .slice(0, limit)
    .map((c) => ({ kind: "collection", id: c.id, name: c.name, coverUrl: c.coverUrl }))
}

/** A topic is matched on both its short name (what a tile shows) and its full
 *  one (what a person is more likely to type). */
export function matchTopics(
  topics: readonly { id: string; shortName: string; fullName: string; coverUrl?: string }[],
  needle: string,
  limit: number
): GroupingHit[] {
  return topics
    .filter((topic) => `${topic.shortName} ${topic.fullName}`.toLocaleLowerCase().includes(needle))
    .slice(0, limit)
    .map((topic) => ({
      kind: "topic",
      id: topic.id,
      // The "#" rides in the name so one shelf can hold both kinds without the
      // card having to know which it is showing.
      name: `#${topic.shortName || topic.fullName || topic.id}`,
      coverUrl: topic.coverUrl,
    }))
}
