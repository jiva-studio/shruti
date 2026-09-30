import type { LanguageCode, TopicId } from "@lib/domain/core.js"
import type { ITopicRepository } from "@lib/domain/ports/topicRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import { searchAndFilterTracks } from "@usecases/discovery/searchAndFilterTracks.js"

/** One collection card within a group. */
export interface GroupCollection {
  readonly id: string
  readonly name: string
  readonly coverUrl?: string
  readonly description?: string
}

/** A named group (shelf) with its ordered collections, ready to render. */
export interface CollectionGroupView {
  readonly id: string
  readonly name: string
  readonly collections: readonly GroupCollection[]
}

export interface CollectionsResult {
  readonly groups: readonly CollectionGroupView[]
  readonly flat: readonly GroupCollection[]
}

/** A collection as the catalog lists it; `cover` is a storage key. */
export interface LandingCollection {
  readonly id: string
  readonly name: string
  readonly cover: string
  readonly description?: string
}

export interface LandingCollectionGroup {
  readonly id: string
  readonly name: string
}

/** The catalog's collection reads the landing needs. */
export interface LandingCollections {
  listGroups(locale: string): Promise<readonly LandingCollectionGroup[]>
  listCollections(locale: string): Promise<readonly LandingCollection[]>
  getGroupCollections(groupId: string, locale: string): Promise<readonly LandingCollection[]>
}

// The "All lectures" preview draws a random sample from this pool; oversized so
// the picked sample shows variety without re-querying.
const PREVIEW_POOL_SIZE = 40

/**
 * The Search landing's reads, one per section. Each returns its result rather
 * than writing store state, so the caller can commit them together — and each
 * degrades to an empty/neutral answer rather than failing the whole load.
 */
export async function loadCollections(
  locale: string,
  deps: {
    readonly collections: LandingCollections
    readonly resolveAssetUrl: (key: string | undefined) => string | undefined
  }
): Promise<CollectionsResult> {
  const { collections, resolveAssetUrl } = deps
  try {
    const [headers, flat] = await Promise.all([
      collections.listGroups(locale),
      collections.listCollections(locale),
    ])
    const built = await Promise.all(
      headers.map(async (g) => {
        const cols = await collections.getGroupCollections(g.id, locale)
        return {
          id: g.id,
          name: g.name,
          collections: cols.map((c) => ({
            id: c.id,
            name: c.name,
            coverUrl: resolveAssetUrl(c.cover),
          })),
        }
      })
    )
    return {
      // Drop empty groups so the page shows no empty shelves.
      groups: built.filter((g) => g.collections.length > 0),
      flat: flat.map((c) => ({
        id: c.id,
        name: c.name,
        coverUrl: resolveAssetUrl(c.cover),
        description: c.description,
      })),
    }
  } catch (err) {
    console.warn("[library-landing] collections load failed", err)
    return { groups: [], flat: [] }
  }
}

export async function loadLecturePool(
  languages: readonly LanguageCode[],
  deps: { readonly tracks: ITrackRepository }
): Promise<readonly Track[]> {
  try {
    return await searchAndFilterTracks(
      {
        query: "",
        languageCodes: languages.length ? languages : undefined,
        limit: PREVIEW_POOL_SIZE,
        offset: 0,
      },
      { tracks: deps.tracks }
    )
  } catch (err) {
    console.warn("[library-landing] lecture pool load failed", err)
    return []
  }
}

/** `null` means "no language filter" — every topic tile passes. */
export async function loadAllowedTopicIds(
  languages: readonly LanguageCode[],
  deps: { readonly topics: ITopicRepository }
): Promise<ReadonlySet<TopicId> | null> {
  if (languages.length === 0) return null
  try {
    return new Set(await deps.topics.topicIdsWithTracksIn(languages))
  } catch (err) {
    console.warn("[library-landing] allowed topic ids load failed", err)
    // Fall back to "no filter" so a failed read never blanks the tile grid.
    return null
  }
}

/** `null` on failure — the count already on screen is kept rather than zeroed. */
export async function loadLectureCount(
  languages: readonly LanguageCode[],
  deps: { readonly tracks: ITrackRepository }
): Promise<number | null> {
  try {
    return await deps.tracks.count(languages.length ? { languageCodes: languages } : undefined)
  } catch (err) {
    console.warn("[library-landing] lecture count failed", err)
    return null
  }
}
